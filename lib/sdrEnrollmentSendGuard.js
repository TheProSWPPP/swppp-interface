export function enrollmentSendBlock(receipt,{machine=false,leaseToken,now=new Date()}={}) {
 if (!receipt) return machine ? 'enrollment_lease_missing' : null;
 if (receipt.status==='accepted') return 'already_sent';
 if (receipt.category==='enrollment_uncertain') return 'enrollment_uncertain';
 if (receipt.status==='running') {
  return machine && leaseToken===receipt.lease_token && new Date(receipt.lease_expires_at)>now ? null : 'enrollment_in_progress';
 }
 // A recovery caller must hold a current claim, rather than reusing a released token.
 return machine ? 'enrollment_lease_missing' : null;
}
