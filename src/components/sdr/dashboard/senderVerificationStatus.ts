export interface SenderVerificationAccount {
  mailbox: string;
  error?: string;
  sendAs?: unknown[];
}

export function senderVerificationIssues(accounts: SenderVerificationAccount[]) {
  return accounts.flatMap(account => {
    if (account.error) {
      const reconnect = /needs reconnect|gmail\.settings\.basic|invalid_grant/i.test(account.error);
      return [{mailbox: account.mailbox, reconnect}];
    }
    const own = Array.isArray(account.sendAs) ? account.sendAs.find(value => value && typeof value === 'object'
      && 'sendAsEmail' in value && String(value.sendAsEmail).toLowerCase() === account.mailbox.toLowerCase()) : undefined;
    if (!own || typeof own !== 'object' || !('displayName' in own)) return [{mailbox: account.mailbox, reconnect: false, blankName: false}];
    return typeof own.displayName === 'string' || own.displayName === null
      ? [] : [{mailbox: account.mailbox, reconnect: false, blankName: false}];
  });
}
