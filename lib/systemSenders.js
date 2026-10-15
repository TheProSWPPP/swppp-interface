// Automated mailboxes (Google Workspace/payments notices, mailer daemons, no-reply senders).
// Their mail can land in a prospect thread but is never a buyer reply.
// The same pattern runs in JavaScript and as a Postgres case-insensitive regex (~*).
export const SYSTEM_SENDER_PATTERN='^([^@]*(no[-_.]?reply|do[-_.]?not[-_.]?reply)[^@]*|mailer-daemon|postmaster|notifications?|calendar-notification)@';
const systemSender=new RegExp(SYSTEM_SENDER_PATTERN,'i');
export const isSystemSender=email=>typeof email==='string'&&systemSender.test(email.trim());
