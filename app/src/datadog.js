// Datadog Real User Monitoring. Credentials come from env vars (see .env.local), never the source.
import { datadogRum } from '@datadog/browser-rum';
import { version } from '../package.json';

const applicationId = import.meta.env.VITE_DD_APPLICATION_ID || '';
const clientToken = import.meta.env.VITE_DD_CLIENT_TOKEN || '';

if (applicationId && clientToken) {
  datadogRum.init({
    applicationId,
    clientToken,
    site: 'datadoghq.com',
    service: 'notechalanttesting',
    env: import.meta.env.MODE,
    version,
    sessionSampleRate: 100,
    sessionReplaySampleRate: 20,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: 'mask',
  });
}
