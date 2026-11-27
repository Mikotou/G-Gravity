import type { TelemetryDashboardSnapshot } from '../../shared/telemetry-contract';

export type TelemetryCharts = Pick<TelemetryDashboardSnapshot,
  'hourly24h' | 'daily7d' | 'matrix7d' | 'calendar30d' | 'costByRange' | 'modelBreakdownByRange'>;

// Only the Electron wire uses this delta. The public bridge preserves the dashboard contract.
export type TelemetryDelta = Pick<TelemetryDashboardSnapshot, 'profileId' | 'sequence' | 'generatedAt' |
  'activeSessions' | 'sessionModelBreakdowns' | 'externalReviewer' | 'externalTranslator' | 'externalVoice'> & {
  changedSessionIds: string[];
  nativeCharts?: TelemetryCharts;
};
