import {OrganizationFixture} from 'sentry-fixture/organization';
import {ProjectFixture} from 'sentry-fixture/project';
import {RepositoryFixture} from 'sentry-fixture/repository';

import {
  act,
  renderGlobalModal,
  screen,
  userEvent,
  waitFor,
} from 'sentry-test/reactTestingLibrary';

import {openModal} from 'sentry/actionCreators/modal';
import {ProjectAddRepoModal} from 'sentry/components/seer/projectAddRepoModal/projectAddRepoModal';
import {ProjectsStore} from 'sentry/stores/projectsStore';

describe('ProjectAddRepoModal', () => {
  const organization = OrganizationFixture();
  const project = ProjectFixture();

  function mockEndpoints() {
    MockApiClient.addMockResponse({
      url: `/organizations/${organization.slug}/repos/`,
      method: 'GET',
      body: [
        RepositoryFixture({
          id: '1',
          name: 'getsentry/sentry',
          externalId: '101',
          provider: {id: 'integrations:github', name: 'GitHub'},
          integrationId: '201',
        }),
        RepositoryFixture({
          id: '3',
          name: 'getsentry/gitlab-repo',
          externalId: '103',
          provider: {id: 'integrations:gitlab', name: 'GitLab'},
          integrationId: '203',
        }),
      ],
    });
    MockApiClient.addMockResponse({
      url: `/organizations/${organization.slug}/seer/projects/`,
      method: 'GET',
      body: [],
    });
    MockApiClient.addMockResponse({
      url: `/organizations/${organization.slug}/integrations/coding-agents/`,
      method: 'GET',
      body: {
        integrations: [{id: '123', provider: 'cursor', name: 'Cursor Cloud Agent'}],
      },
    });
  }

  beforeEach(() => {
    ProjectsStore.loadInitialData([project]);
    mockEndpoints();
  });

  afterEach(() => {
    MockApiClient.clearMockResponses();
    ProjectsStore.reset();
  });

  function openAddRepoModal(org = organization) {
    renderGlobalModal({organization: org});
    act(() => {
      openModal(modalProps => (
        <ProjectAddRepoModal {...modalProps} title="Add Project to Autofix" />
      ));
    });
  }

  async function addRepository(name: RegExp) {
    await userEvent.click(await screen.findByRole('button', {name: 'Add Repository'}));
    await userEvent.click(await screen.findByRole('option', {name}));
  }

  it('keeps the agent dropdown enabled for a GitHub repo', async () => {
    openAddRepoModal();

    expect(await screen.findByRole('textbox', {name: 'Handoff to Agent'})).toBeEnabled();

    await addRepository(/getsentry\/sentry/);

    expect(screen.getByRole('textbox', {name: 'Handoff to Agent'})).toBeEnabled();
    expect(
      screen.queryByText(/GitLab repositories can only hand off to Seer/)
    ).not.toBeInTheDocument();
  });

  it('disables the agent dropdown and warns when a GitLab repo is added', async () => {
    openAddRepoModal();

    await addRepository(/gitlab-repo/);

    await waitFor(() =>
      expect(screen.getByRole('textbox', {name: 'Handoff to Agent'})).toBeDisabled()
    );
    expect(
      screen.getByText(/GitLab repositories can only hand off to Seer/)
    ).toBeInTheDocument();
  });

  it('saves Seer as the agent when a GitLab repo is attached, even if the org default is a coding agent', async () => {
    // Org default points at the Cursor integration, so the agent field would
    // otherwise be saved as cursor. Attaching a GitLab repo must coerce it.
    const orgWithDefault = OrganizationFixture({defaultCodingAgentIntegrationId: 123});

    const reposPut = MockApiClient.addMockResponse({
      url: `/projects/${orgWithDefault.slug}/${project.slug}/seer/repos/`,
      method: 'PUT',
    });
    const settingsPut = MockApiClient.addMockResponse({
      url: `/projects/${orgWithDefault.slug}/${project.slug}/seer/settings/`,
      method: 'PUT',
      body: {},
    });

    openAddRepoModal(orgWithDefault);

    // Pick the project.
    await userEvent.click(await screen.findByRole('button', {name: 'Select Project'}));
    await userEvent.click(await screen.findByRole('option', {name: /project-slug/}));

    await addRepository(/gitlab-repo/);
    await waitFor(() =>
      expect(screen.getByRole('textbox', {name: 'Handoff to Agent'})).toBeDisabled()
    );

    await userEvent.click(screen.getByRole('button', {name: 'Save Project'}));

    await waitFor(() => expect(reposPut).toHaveBeenCalled());
    expect(settingsPut).toHaveBeenCalledWith(
      `/projects/${orgWithDefault.slug}/${project.slug}/seer/settings/`,
      expect.objectContaining({data: expect.objectContaining({agent: 'seer'})})
    );
    // The coercion must not carry the coding-agent integration id either.
    expect(settingsPut).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({data: expect.objectContaining({integrationId: '123'})})
    );
  });

  it('re-enables the agent dropdown when the GitLab repo is removed', async () => {
    openAddRepoModal();

    await addRepository(/gitlab-repo/);
    await waitFor(() =>
      expect(screen.getByRole('textbox', {name: 'Handoff to Agent'})).toBeDisabled()
    );

    await userEvent.click(screen.getByRole('button', {name: 'Remove repository'}));

    await waitFor(() =>
      expect(screen.getByRole('textbox', {name: 'Handoff to Agent'})).toBeEnabled()
    );
    expect(
      screen.queryByText(/GitLab repositories can only hand off to Seer/)
    ).not.toBeInTheDocument();
  });
});
