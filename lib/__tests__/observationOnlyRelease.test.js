import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
const hash=value=>createHash('sha256').update(value).digest('hex');
it('preserves outbound modules outside the manual protection release',()=>{
 // Revision/send/context changes have behavioral tests; the document contract remains pinned separately.
 const expected={'lib/sdrDraftGenerator.js': '4436f6afa64a52117d6410509ca61d2a993a10db1ae7c783a1de5ed028109f84', 'lib/sdrCrmGuard.js': '6840ae6263934f000400c5cfdc8e8216b1a3808cc20d178e465c5fb25ab5de66', 'lib/sdrEnrollmentSendGuard.js': '1a6c7100483086cf7f1ee80ae2f7126ee07235309ff5330cbdcd6fd810df4e2c'};
 for(const [file,digest] of Object.entries(expected))expect(hash(readFileSync(new URL('../../'+file,import.meta.url)))).toBe(digest);
});
it('exposes only observation reads in the new client API',()=>{
 const source=readFileSync(new URL('../../src/lib/sdrCrmApi.ts',import.meta.url),'utf8');
 expect(source).not.toMatch(/method:|acknowledge:|hold:|review:/);
});
