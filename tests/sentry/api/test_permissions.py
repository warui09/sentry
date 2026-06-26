import pytest
from rest_framework.views import APIView

from sentry.api.bases.organization import OrganizationPermission
from sentry.api.bases.project import ProjectPermission
from sentry.api.exceptions import InsufficientScope
from sentry.api.permissions import (
    DemoSafePermission,
    DisallowImpersonatedTokenCreation,
    SentryIsAuthenticated,
    StaffPermission,
    SuperuserOrStaffFeatureFlaggedPermission,
    SuperuserPermission,
)
from sentry.demo_mode.utils import READONLY_SCOPES
from sentry.organizations.services.organization import organization_service
from sentry.testutils.cases import APITestCase, DRFPermissionTestCase
from sentry.testutils.helpers.options import override_options


class PermissionsTest(DRFPermissionTestCase):
    superuser_permission = SuperuserPermission()
    staff_permission = StaffPermission()
    superuser_staff_flagged_permission = SuperuserOrStaffFeatureFlaggedPermission()

    def test_superuser_permission(self) -> None:
        assert self.superuser_permission.has_permission(self.superuser_request, APIView())

    def test_staff_permission(self) -> None:
        assert self.staff_permission.has_permission(self.staff_request, APIView())

    @override_options({"staff.ga-rollout": True})
    def test_superuser_or_staff_feature_flagged_permission_active_option(self) -> None:
        # With active superuser
        assert not self.superuser_staff_flagged_permission.has_permission(
            self.superuser_request, APIView()
        )

        # With active staff
        assert self.superuser_staff_flagged_permission.has_permission(self.staff_request, APIView())

    def test_superuser_or_staff_feature_flagged_permission_inactive_option(self) -> None:
        # With active staff
        assert not self.superuser_staff_flagged_permission.has_permission(
            self.staff_request, APIView()
        )

        # With active superuser
        assert self.superuser_staff_flagged_permission.has_permission(
            self.superuser_request, APIView()
        )


class DisallowImpersonatedTokenCreationTest(DRFPermissionTestCase):
    permission = DisallowImpersonatedTokenCreation()

    def setUp(self) -> None:
        super().setUp()
        self.normal_user = self.create_user()
        self.impersonator = self.create_user(is_superuser=True)

    def test_safe_methods_allowed_during_impersonation(self) -> None:
        for method in ("GET", "HEAD", "OPTIONS"):
            request = self.make_request(user=self.normal_user, method=method)
            request.actual_user = self.impersonator  # type: ignore[attr-defined]
            assert self.permission.has_permission(request, APIView())

    def test_unsafe_methods_blocked_during_impersonation(self) -> None:
        for method in ("POST", "PUT", "DELETE"):
            request = self.make_request(user=self.normal_user, method=method)
            request.actual_user = self.impersonator  # type: ignore[attr-defined]
            assert not self.permission.has_permission(request, APIView())

    def test_unsafe_methods_allowed_without_impersonation(self) -> None:
        for method in ("POST", "PUT", "DELETE"):
            request = self.make_request(user=self.normal_user, method=method)
            assert self.permission.has_permission(request, APIView())


class IsAuthenticatedPermissionsTest(DRFPermissionTestCase):
    user_permission = SentryIsAuthenticated()

    def setUp(self) -> None:
        super().setUp()
        self.normal_user = self.create_user()
        self.readonly_user = self.create_user()

    def test_has_permission(self) -> None:
        with override_options(
            {"demo-mode.enabled": True, "demo-mode.users": [self.readonly_user.id]}
        ):
            assert self.user_permission.has_permission(
                self.make_request(self.normal_user), APIView()
            )
            assert not self.user_permission.has_permission(
                self.make_request(self.readonly_user), APIView()
            )

    def test_has_object_permission(self) -> None:
        with override_options(
            {"demo-mode.enabled": True, "demo-mode.users": [self.readonly_user.id]}
        ):
            assert self.user_permission.has_object_permission(
                self.make_request(self.normal_user), APIView(), None
            )
            assert not self.user_permission.has_object_permission(
                self.make_request(self.readonly_user), APIView(), None
            )


class InsufficientScopeTest(DRFPermissionTestCase):
    """A token-authorized request denied for lacking scope advertises the required scopes
    via an RFC 6750 ``insufficient_scope`` challenge instead of a bare 403."""

    permission = OrganizationPermission()

    def setUp(self) -> None:
        super().setUp()
        self.user = self.create_user()
        self.organization = self.create_organization(owner=self.user)

    def _token_request(self, scopes, method):
        token = self.create_user_auth_token(user=self.user, scope_list=list(scopes))
        return self.make_request(user=self.user, auth=token, method=method)

    def test_under_scoped_token_raises_insufficient_scope(self) -> None:
        # PUT requires org:write/org:admin; a read-only token holds neither.
        request = self._token_request(["org:read"], "PUT")
        with pytest.raises(InsufficientScope) as excinfo:
            self.permission.has_permission(request, APIView())

        exc = excinfo.value
        assert exc.status_code == 403
        # Required scopes, sorted and space-delimited, per RFC 6750.
        assert exc.auth_header == 'Bearer error="insufficient_scope", scope="org:admin org:write"'

    def test_header_scope_is_method_specific(self) -> None:
        # DELETE on an org endpoint requires only org:admin; the challenge advertises exactly
        # that, proving the scope list is derived from the method's scope_map (not hardcoded).
        request = self._token_request(["org:read"], "DELETE")
        with pytest.raises(InsufficientScope) as excinfo:
            self.permission.has_permission(request, APIView())
        assert excinfo.value.auth_header == 'Bearer error="insufficient_scope", scope="org:admin"'

    def test_challenge_is_generic_across_permission_classes(self) -> None:
        # The challenge comes from the shared ScopedPermission gate, so any permission class
        # gets it with its own scope_map -- here ProjectPermission's project scopes.
        request = self._token_request(["project:read"], "PUT")
        with pytest.raises(InsufficientScope) as excinfo:
            ProjectPermission().has_permission(request, APIView())
        assert (
            excinfo.value.auth_header
            == 'Bearer error="insufficient_scope", scope="project:admin project:write"'
        )

    def test_token_with_required_scope_is_allowed(self) -> None:
        request = self._token_request(["org:write"], "PUT")
        assert self.permission.has_permission(request, APIView())

    def test_read_token_on_safe_method_is_allowed(self) -> None:
        request = self._token_request(["org:read"], "GET")
        assert self.permission.has_permission(request, APIView())

    def test_session_request_does_not_raise(self) -> None:
        # No token: the view-level check defers to is_authenticated and scope enforcement
        # happens at the object level, so no insufficient_scope challenge is raised here.
        request = self.make_request(user=self.user, method="PUT")
        assert self.permission.has_permission(request, APIView())


class DemoSafePermissionsTest(DRFPermissionTestCase):
    user_permission = DemoSafePermission()

    def setUp(self) -> None:
        super().setUp()
        self.normal_user = self.create_user()
        self.readonly_user = self.create_user()
        self.organization = self.create_organization(owner=self.normal_user)
        self.org_member_scopes = self.create_member(
            organization_id=self.organization.id, user_id=self.readonly_user.id
        ).get_scopes()

    def _get_rpc_context(self, user):
        rpc_context = organization_service.get_organization_by_id(
            id=self.organization.id, user_id=user.id
        )

        assert rpc_context
        return rpc_context

    def test_safe_methods(self) -> None:
        with override_options(
            {"demo-mode.enabled": True, "demo-mode.users": [self.readonly_user.id]}
        ):
            for method in ("GET", "HEAD", "OPTIONS"):
                assert self.user_permission.has_permission(
                    self.make_request(self.readonly_user, method=method), APIView()
                )
                assert self.user_permission.has_permission(
                    self.make_request(self.normal_user, method=method), APIView()
                )

    def test_unsafe_methods(self) -> None:
        with override_options(
            {"demo-mode.enabled": True, "demo-mode.users": [self.readonly_user.id]}
        ):
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                assert not self.user_permission.has_permission(
                    self.make_request(self.readonly_user, method=method), APIView()
                )
                assert self.user_permission.has_permission(
                    self.make_request(self.normal_user, method=method), APIView()
                )

    def test_safe_method_demo_mode_disabled(self) -> None:
        with override_options(
            {"demo-mode.enabled": False, "demo-mode.users": [self.readonly_user.id]}
        ):
            for method in ("GET", "HEAD", "OPTIONS"):
                assert not self.user_permission.has_permission(
                    self.make_request(self.readonly_user, method=method), APIView()
                )
                assert self.user_permission.has_permission(
                    self.make_request(self.normal_user, method=method), APIView()
                )

    def test_unsafe_methods_demo_mode_disabled(self) -> None:
        with override_options(
            {"demo-mode.enabled": False, "demo-mode.users": [self.readonly_user.id]}
        ):
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                assert not self.user_permission.has_permission(
                    self.make_request(self.readonly_user, method=method), APIView()
                )
                assert self.user_permission.has_permission(
                    self.make_request(self.normal_user, method=method), APIView()
                )

    def test_determine_access_disabled(self) -> None:
        with override_options(
            {"demo-mode.enabled": False, "demo-mode.users": [self.readonly_user.id]}
        ):
            self.user_permission.determine_access(
                request=self.make_request(self.normal_user),
                organization=self._get_rpc_context(self.normal_user),
            )

            readonly_rpc_context = self._get_rpc_context(self.readonly_user)

            self.user_permission.determine_access(
                request=self.make_request(self.readonly_user),
                organization=readonly_rpc_context,
            )

            assert readonly_rpc_context.member.scopes == list(self.org_member_scopes)

    def test_determine_access(self) -> None:
        with override_options(
            {"demo-mode.enabled": True, "demo-mode.users": [self.readonly_user.id]}
        ):
            self.user_permission.determine_access(
                request=self.make_request(self.normal_user),
                organization=self._get_rpc_context(self.normal_user),
            )

            readonly_rpc_context = self._get_rpc_context(self.readonly_user)

            self.user_permission.determine_access(
                request=self.make_request(self.readonly_user),
                organization=readonly_rpc_context,
            )

            assert readonly_rpc_context.member.scopes == sorted(READONLY_SCOPES)

    def test_determine_access_no_demo_users(self) -> None:
        with override_options({"demo-mode.enabled": False, "demo-mode.users": []}):
            self.user_permission.determine_access(
                request=self.make_request(self.normal_user),
                organization=self._get_rpc_context(self.normal_user),
            )

            readonly_rpc_context = self._get_rpc_context(self.readonly_user)

            self.user_permission.determine_access(
                request=self.make_request(self.readonly_user),
                organization=readonly_rpc_context,
            )

            assert readonly_rpc_context.member.scopes == list(self.org_member_scopes)


class InsufficientScopeResponseTest(APITestCase):
    """End-to-end: a token-scope denial reaches the client as a 403 carrying the RFC 6750
    insufficient_scope WWW-Authenticate header (via custom_exception_handler)."""

    endpoint = "sentry-api-0-organization-details"

    def setUp(self) -> None:
        super().setUp()
        self.organization = self.create_organization(owner=self.user)

    def _token(self, scopes):
        return self.create_user_auth_token(user=self.user, scope_list=list(scopes))

    def test_under_scoped_token_put_returns_insufficient_scope_header(self) -> None:
        token = self._token(["org:read"])
        response = self.get_error_response(
            self.organization.slug,
            method="put",
            extra_headers={"HTTP_AUTHORIZATION": f"Bearer {token.token}"},
            status_code=403,
        )
        assert (
            response["WWW-Authenticate"]
            == 'Bearer error="insufficient_scope", scope="org:admin org:write"'
        )
        # The body contract is unchanged: still a {"detail": ...} message, no new keys.
        assert set(response.data.keys()) == {"detail"}

    def test_sufficiently_scoped_token_get_has_no_challenge(self) -> None:
        token = self._token(["org:read"])
        response = self.get_success_response(
            self.organization.slug,
            extra_headers={"HTTP_AUTHORIZATION": f"Bearer {token.token}"},
        )
        assert "WWW-Authenticate" not in response

    def test_session_denial_has_no_insufficient_scope_challenge(self) -> None:
        # A session-authed member without org:write is denied at the object level, not the
        # token-scope gate, so it must not carry an insufficient_scope challenge.
        member = self.create_user()
        self.create_member(organization=self.organization, user=member, role="member")
        self.login_as(member)
        response = self.get_error_response(self.organization.slug, method="put", status_code=403)
        assert "insufficient_scope" not in response.get("WWW-Authenticate", "")

    def test_unauthenticated_request_has_no_insufficient_scope_challenge(self) -> None:
        # No credentials -> 401 authentication failure, never an insufficient_scope challenge.
        response = self.get_error_response(self.organization.slug, method="put", status_code=401)
        assert "insufficient_scope" not in response.get("WWW-Authenticate", "")
