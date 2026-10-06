import {renderOutreachEvent} from './sdrNoteEvents.js';
import {addNote as appendNote} from './pipedriveClient.js';
export async function publishOutreachEvent(db,{leadId,event},{addNote=appendNote}={}) {
 const rendered=renderOutreachEvent(event);
 if(!leadId||!rendered.eventKey)throw new Error('note_source_identity_required');
 const inserted=await db.query(`INSERT INTO sdr_note_events(event_key,lead_id,evidence,content) VALUES($1,$2,$3,$4)
  ON CONFLICT(event_key,lead_id) DO NOTHING RETURNING event_key`,[rendered.eventKey,String(leadId),rendered.evidence,rendered.html]);
 if(!inserted.rowCount)return {status:'already_recorded',eventKey:rendered.eventKey};
 let note;
 try{note=await addNote({leadId,content:rendered.html});}catch{return {status:'unresolved',eventKey:rendered.eventKey};}
 if(!note?.id)return {status:'unresolved',eventKey:rendered.eventKey};
 await db.query("UPDATE sdr_note_events SET status='confirmed',provider_note_id=$3,confirmed_at=NOW() WHERE event_key=$1 AND lead_id=$2",[rendered.eventKey,String(leadId),String(note.id)]);
 return {status:'confirmed',eventKey:rendered.eventKey,noteId:String(note.id)};
}
