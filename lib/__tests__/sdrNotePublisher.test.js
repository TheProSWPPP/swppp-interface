import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import {reportingTestDb} from './reportingTestDb.js';
import {publishOutreachEvent} from '../sdrNotePublisher.js';
const db=reportingTestDb('note_publisher');
describe.skipIf(!db)('append-only note publishing',()=>{
 beforeAll(async()=>{await db.setup();await db.pool.query(await fs.readFile(new URL('../../migrations/2026-10-07-sdr-note-events.sql',import.meta.url),'utf8'));});
 afterAll(async()=>{await db.close();});
 const event=id=>({type:'queued',source:{kind:'apollo',eventId:id},result:{status:'enrolled',receipt:{acceptedContactId:'synthetic'}},recipient:'synthetic@example.invalid'});
 it('publishes one note for a repeated source event, retaining separate identical events',async()=>{
  const addNote=vi.fn(async()=>({id:42}));
  await publishOutreachEvent(db.pool,{leadId:'lead',event:event('one')},{addNote});
  await publishOutreachEvent(db.pool,{leadId:'lead',event:event('one')},{addNote});
  await publishOutreachEvent(db.pool,{leadId:'lead',event:event('two')},{addNote});
  expect(addNote).toHaveBeenCalledTimes(2);
  expect(addNote.mock.calls[0][0].content).toContain('Outreach queued');
  expect(addNote.mock.calls[0][0].content).not.toContain('Email sent');
 });
 it('never replays an uncertain provider result or overwrites an existing note',async()=>{
  const addNote=vi.fn(async()=>{throw new Error('timeout');});
  expect(await publishOutreachEvent(db.pool,{leadId:'lead',event:event('uncertain')},{addNote})).toMatchObject({status:'unresolved'});
  await publishOutreachEvent(db.pool,{leadId:'lead',event:event('uncertain')},{addNote});
  expect(addNote).toHaveBeenCalledTimes(1);
 });
});
