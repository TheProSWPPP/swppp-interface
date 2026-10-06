import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
const hash=value=>createHash('sha256').update(value).digest('hex');
it('preserves the original server including all draft, send, verification and sync handlers',()=>{
 const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
 const original=source.replace(/^[ \t]*\/\/ BEGIN OBSERVATION ADDITION[\s\S]*?^[ \t]*\/\/ END OBSERVATION ADDITION\n/gm,'');
 expect(hash(original)).toBe('3de894ce3a883d57cfce2f984d37f7fffc21aa98d57107399d5e5ebb4d0391a6');
});
it('preserves outbound modules byte for byte',()=>{
 const expected={'lib/emailVerifyRefresh.js': '75f1223222365f078a12438c976579c0c8bf368926f6f98aee2506b224305b0b', 'lib/sdrAutoSwitch.js': '14263cc512e2448b367ad584fb14aa6549ed8e7879ee6702d98a91e8cf6d2fa2', 'lib/pipedriveClient.js': 'f3d25fba606487a452eea9e3fd01995e7e8edc429e04bdf1af33d7af1b26ab2e', 'lib/pipedriveSync.js': 'd754adc9eb467e9d7fcfd21c7d49b756926d45a3284d6018cd69c50369dea6cf', 'lib/sdrDraftGenerator.js': '4436f6afa64a52117d6410509ca61d2a993a10db1ae7c783a1de5ed028109f84', 'lib/autoOutreach.js': '3d95a372089b8259781034ccbb188ecabd93d4fb821e97e2917635126b44acf0', 'lib/sdrCrmGuard.js': '6840ae6263934f000400c5cfdc8e8216b1a3808cc20d178e465c5fb25ab5de66', 'lib/sdrEnrollmentSendGuard.js': '1a6c7100483086cf7f1ee80ae2f7126ee07235309ff5330cbdcd6fd810df4e2c'};
 for(const [file,digest] of Object.entries(expected))expect(hash(readFileSync(new URL('../../'+file,import.meta.url)))).toBe(digest);
});
it('exposes only observation reads in the new client API',()=>{
 const source=readFileSync(new URL('../../src/lib/sdrCrmApi.ts',import.meta.url),'utf8');
 expect(source).not.toMatch(/method:|acknowledge:|hold:|review:/);
});
