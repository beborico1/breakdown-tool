import { isGoogleChat } from '../chat/message-finder.js';
import { isGmail } from '../gmail/message-finder.js';
import { isRedmine } from '../redmine/message-finder.js';
import { S } from '../../metrics/events.js';

/**
 * Which surface this frame is running on, as a metrics dimension.
 *
 * Lives here rather than in src/metrics/ so that package stays a leaf with no
 * imports outside itself: the extension pages load raw ES modules, so a metrics
 * module importing these three detectors would pull the whole content-script
 * graph into every page and create an import cycle with the universal colorizer.
 * @returns {string} a value from S
 */
export function surface() {
  if (typeof window === 'undefined') return S.PAGE;
  if (window.location.hostname === 'meet.google.com') return S.MEET;
  if (isGoogleChat()) return S.CHAT;
  if (isGmail()) return S.GMAIL;
  if (isRedmine()) return S.REDMINE;
  return S.UNIVERSAL;
}
