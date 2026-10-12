import { Lead } from '../../models/index.js';
import { notify } from '../../utils/notify.js';
import { istStartOfDay, istEndOfDay } from '../../utils/helpers.js';
import { istKey } from './common.js';

// Creates one "due today" and one "overdue" notification per lead per day (idempotent via notification key).
export async function runFollowUpCheck() {
  const now = new Date();
  const todayStart = istStartOfDay(now), todayEnd = istEndOfDay(now);
  const day = istKey(now);
  const due = await Lead.find({ isDraft: false, status: { $nin: ['Converted', 'Rejected'] }, nextFollowUpAt: { $ne: null, $lte: todayEnd } })
    .select('name company nextFollowUpAt phone').limit(500).lean();
  for (const l of due) {
    const overdue = l.nextFollowUpAt < todayStart;
    const who = l.name || l.company || 'a lead';
    await notify({
      kind: overdue ? 'followup_overdue' : 'followup_due', key: `${overdue ? 'fu-over' : 'fu-due'}:${l._id}:${day}`, leadId: l._id,
      title: overdue ? `Overdue follow-up: ${who}` : `Follow-up due today: ${who}`,
      body: `${l.phone || ''}`, link: `/admin/leads/${l._id}`, email: !overdue,
    });
  }
  return due.length;
}

export function startScheduler() {
  const run = () => runFollowUpCheck().catch((e) => console.warn('[scheduler]', e.message));
  setTimeout(run, 5000).unref();
  setInterval(run, 15 * 60 * 1000).unref();
  console.log('[scheduler] follow-up reminders active');
}
