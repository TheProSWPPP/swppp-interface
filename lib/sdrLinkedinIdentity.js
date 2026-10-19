import {canonicalProfile} from './sdrLinkedinStore.js';
export function classifyLinkedinProviderId(id){if(/^ACo[A-Za-z0-9_-]+$/.test(id||''))return 'classic';if(/^ACw[A-Za-z0-9_-]+$/.test(id||''))return 'sales_navigator';return 'unknown'}
export function assertLinkedinIdentityEvidence(evidence){if(classifyLinkedinProviderId(evidence?.providerId)!==evidence?.product||evidence?.product!=='classic')throw Error('product_mismatch');canonicalProfile(evidence.profileUrl);if(!evidence.personId||!evidence.organizationId||!evidence.ownerId)throw Error('crm_identity_unverified');return true}
