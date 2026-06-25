import {useCallback, useEffect, useMemo} from 'react';
import type {QueryClient, QueryFunctionContext} from '@tanstack/react-query';
import {skipToken, useQueries, useQuery} from '@tanstack/react-query';

import {normalizeDateTimeParams} from 'sentry/components/pageFilters/parse';
import {usePageFilters} from 'sentry/components/pageFilters/usePageFilters';
import {apiFetch} from 'sentry/utils/api/apiFetch';
import {getApiUrl} from 'sentry/utils/api/getApiUrl';
import {DiscoverDatasets} from 'sentry/utils/discover/types';
import {useOrganization} from 'sentry/utils/useOrganization';
import {SAMPLING_MODE} from 'sentry/views/explore/hooks/useProgressiveQuery';
import {AlwaysPresentLogFields} from 'sentry/views/explore/logs/constants';
import type {LogsPinning} from 'sentry/views/explore/logs/pinning/useLogsPinning';
import {
  OurLogKnownFieldKey,
  type EventsLogsResult,
  type OurLogsResponseItem,
} from 'sentry/views/explore/logs/types';
import type {LogTableRowItem} from 'sentry/views/explore/logs/utils';
import {useQueryParamsFields} from 'sentry/views/explore/queryParams/context';

interface PinnedLogsOptions {
  allRows: LogTableRowItem[];
  logsPinning: LogsPinning | undefined;
}

const DRIVER_QUERY_KEY = 'pinned-logs-driver';

/**
 * Practically-infinite period so the wide step finds any log still in retention,
 * regardless of the selected range. The backend clamps it to the org's retention.
 */
const WIDE_STATS_PERIOD = '9999d';

function pinnedLogRowQueryKey(id: string) {
  return ['pinned-log-row', id] as const;
}

export function usePinnedLogsQuery({allRows, logsPinning}: PinnedLogsOptions) {
  const missingIds = useMissingPinnedLogIds(allRows, logsPinning);
  const isFetching = usePinnedLogFetcher(missingIds, logsPinning);
  const {rows, resolvedIds} = useCachedPinnedLogRows(missingIds);

  return {
    fetchedRows: rows,
    isPending: isFetching && missingIds.some(id => !resolvedIds.has(id)),
  };
}

/** Pinned ids that aren't already present in the loaded table rows. */
function useMissingPinnedLogIds(
  allRows: LogTableRowItem[],
  logsPinning: LogsPinning | undefined
) {
  return useMemo(() => {
    const allRowIds = new Set(allRows.map(row => row[OurLogKnownFieldKey.ID]));
    const pinnedIds = logsPinning?.getPinnedRowIds() ?? [];
    return pinnedIds.filter(id => !allRowIds.has(id));
  }, [logsPinning, allRows]);
}

function usePinnedLogFetcher(missingIds: string[], logsPinning: LogsPinning | undefined) {
  const organization = useOrganization();
  const {selection, isReady: pageFiltersReady} = usePageFilters();
  const userFields = useQueryParamsFields();

  const baseQuery = useMemo(
    () => ({
      dataset: DiscoverDatasets.OURLOGS,
      field: Array.from(new Set([...AlwaysPresentLogFields, ...userFields])),
      project: selection.projects,
      environment: selection.environments,
      sampling: SAMPLING_MODE.HIGH_ACCURACY,
      referrer: 'api.explore.logs-pinned',
    }),
    [userFields, selection.projects, selection.environments]
  );
  const inRangeDateParams = useMemo(
    () => normalizeDateTimeParams(selection.datetime),
    [selection.datetime]
  );

  const driver = useQuery({
    queryKey: [
      DRIVER_QUERY_KEY,
      {
        organizationSlug: organization.slug,
        ids: [...missingIds].sort(),
        baseQuery,
        dateParams: inRangeDateParams,
      },
    ],
    enabled: pageFiltersReady && !!logsPinning && missingIds.length > 0,
    staleTime: 0,
    queryFn: context =>
      fetchAndCachePinnedLogs(context, {
        ids: missingIds,
        organizationSlug: organization.slug,
        baseQuery,
        inRangeDateParams,
      }),
  });

  const notFoundIds = driver.data;
  const removePinnedRows = logsPinning?.removePinnedRows;
  useEffect(() => {
    if (removePinnedRows && notFoundIds?.length) {
      removePinnedRows(notFoundIds);
    }
  }, [notFoundIds, removePinnedRows]);

  return driver.fetchStatus === 'fetching';
}

function useCachedPinnedLogRows(missingIds: string[]) {
  const combine = useCallback(
    (results: Array<{data: unknown}>) => {
      const rows: OurLogsResponseItem[] = [];
      const resolvedIds = new Set<string>();
      results.forEach((result, index) => {
        const row = result.data as OurLogsResponseItem | undefined;
        if (row) {
          rows.push(row);
          resolvedIds.add(missingIds[index]!);
        }
      });
      return {rows, resolvedIds};
    },
    [missingIds]
  );

  return useQueries({
    queries: missingIds.map(id => ({
      queryKey: pinnedLogRowQueryKey(id),
      queryFn: skipToken,
      staleTime: Infinity,
    })),
    combine,
  });
}

type FetchAndCacheContext = Pick<QueryFunctionContext, 'signal' | 'meta'> & {
  client: QueryClient;
};

interface FetchAndCacheOptions {
  baseQuery: Record<string, unknown>;
  ids: string[];
  inRangeDateParams: Record<string, unknown>;
  organizationSlug: string;
}

async function fetchAndCachePinnedLogs(
  {client, signal, meta}: FetchAndCacheContext,
  {ids, organizationSlug, baseQuery, inRangeDateParams}: FetchAndCacheOptions
): Promise<string[]> {
  const idsToFetch = ids.filter(id => !client.getQueryData(pinnedLogRowQueryKey(id)));
  if (idsToFetch.length === 0) {
    return [];
  }

  const url = getApiUrl('/organizations/$organizationIdOrSlug/events/', {
    path: {organizationIdOrSlug: organizationSlug},
  });

  const fetchByIds = (idsForFetch: string[], dateParams: Record<string, unknown>) => {
    return apiFetch<EventsLogsResult>({
      client,
      signal,
      meta,
      queryKey: [
        url,
        {
          query: {
            ...baseQuery,
            ...dateParams,
            query: `id:[${idsForFetch.join(',')}]`,
            per_page: idsForFetch.length,
          },
        },
        {infinite: false},
      ],
    });
  };

  // Step 1: Search in the parent selected range for pins that are not loaded yet.
  // Start with this smaller range so we don't have to scan the org's full retention period.
  let foundInRange = new Set<string>();
  try {
    foundInRange = seedAndCollect(
      client,
      (await fetchByIds(idsToFetch, inRangeDateParams)).json
    );
  } catch {
    // The selected range failed; let the wide window resolve everything instead.
  }

  const stillMissing = idsToFetch.filter(id => !foundInRange.has(id));
  if (stillMissing.length === 0) {
    return [];
  }

  // Step 2: Any IDs not found in the parent selected range escalate to a wide window.
  const wide = await fetchByIds(stillMissing, {statsPeriod: WIDE_STATS_PERIOD});
  const foundWide = seedAndCollect(client, wide.json);

  // A partial scan didn't prove the unfound ids absent, so don't unpin them.
  if (wide.json.meta?.dataScanned === 'partial') {
    return [];
  }

  return stillMissing.filter(id => !foundWide.has(id));
}

const seedAndCollect = (client: QueryClient, result: EventsLogsResult) => {
  const foundIds = new Set<string>();

  for (const row of result.data) {
    const id = row[OurLogKnownFieldKey.ID];
    client.setQueryData(pinnedLogRowQueryKey(id), row);
    foundIds.add(id);
  }

  return foundIds;
};
