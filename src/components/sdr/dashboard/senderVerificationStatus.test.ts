import {describe, expect, it} from 'vitest';
import {senderVerificationIssues} from './senderVerificationStatus';
describe('Gmail sender verification', () => {
  it('keeps nested permission failures visible even when the endpoint succeeds', () => {
    expect(senderVerificationIssues([{mailbox: 'a@example.com', error: 'needs reconnect: token predates gmail.settings.basic'}, {mailbox: 'b@example.com', sendAs: [{sendAsEmail:'b@example.com',displayName:'Rep'}]}])).toEqual([{mailbox: 'a@example.com', reconnect: true}]);
  });
  it('recognizes revoked OAuth access separately from unreadable sender settings', () => {
    expect(senderVerificationIssues([{mailbox:'a@example.com',error:'token refresh failed: invalid_grant Token expired or revoked.'}])).toEqual([{mailbox:'a@example.com',reconnect:true}]);
  });
  it('does not certify empty or missing sender settings', () => {
    expect(senderVerificationIssues([{mailbox: 'a@example.com', sendAs: []}, {mailbox: 'b@example.com'}])).toEqual([{mailbox: 'a@example.com', reconnect: false,blankName:false}, {mailbox: 'b@example.com', reconnect: false,blankName:false}]);
  });
  it('distinguishes a readable blank name from a permission failure', () => {
    expect(senderVerificationIssues([{mailbox:'a@example.com',sendAs:[{sendAsEmail:'a@example.com',displayName:null,isPrimary:true}]}])).toEqual([]);
  });
  it('does not certify an unrelated alias or a malformed response', () => {
    expect(senderVerificationIssues([{mailbox:'a@example.com',sendAs:[{sendAsEmail:'alias@example.com',displayName:'Rep'}]},{mailbox:'b@example.com',sendAs:[{}]},{mailbox:'c@example.com',sendAs:{} as unknown as unknown[]}])).toEqual([{mailbox:'a@example.com',reconnect:false,blankName:false},{mailbox:'b@example.com',reconnect:false,blankName:false},{mailbox:'c@example.com',reconnect:false,blankName:false}]);
  });
});
