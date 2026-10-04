import {afterEach,describe,expect,it,vi} from 'vitest';
import {pollInboxReplies} from '../inboxReplyWatch.js';
import {listThreads} from '../gmailInbox.js';
import * as apollo from '../apolloClient.js';
import * as pipedrive from '../pipedriveClient.js';

vi.mock('../apolloClient.js',()=>({removeContactsFromSequence:vi.fn(async()=>({}))}));
vi.mock('../pipedriveClient.js',()=>({addActivity:vi.fn(async()=>({id:601})),addNote:vi.fn(async()=>({id:602}))}));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.clearAllMocks();});

describe('Cc display and legacy reply targeting',()=>{
  it('keeps a copied colleague visible without targeting their other project',async()=>{
    vi.stubEnv('PIPEDRIVE_API_TOKEN','fixture-pipedrive');
    vi.stubEnv('APOLLO_API_KEY','fixture-apollo');
    vi.stubEnv('GEMINI_API_KEY','');
    const message={id:'incoming',internalDate:String(Date.now()),snippet:'Please send a quote',labelIds:['INBOX'],payload:{mimeType:'text/plain',body:{data:Buffer.from('Please send a quote').toString('base64url')},headers:[
      {name:'From',value:'Buyer <buyer@buyer.test>'},{name:'To',value:'rep@example.test'},
      {name:'Cc',value:'Colleague <colleague@buyer.test>'},{name:'Subject',value:'Project A'},
      {name:'Date',value:new Date().toUTCString()},{name:'Message-ID',value:'<incoming@buyer.test>'},
    ]}};
    vi.stubGlobal('fetch',async(url,options={})=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/messages/send')) return {ok:true,json:async()=>({id:'forward-receipt'})};
      if(path.endsWith('/threads')) return {ok:true,json:async()=>({threads:[{id:'conversation'}]})};
      if(path.endsWith('/threads/conversation')) return {ok:true,json:async()=>({messages:[message]})};
      throw new Error(`Unexpected fixture request ${options.method||'GET'} ${path}`);
    });
    const pool={query:vi.fn(async(sql,args=[])=>{
      if(sql.includes('SELECT a.mailbox_email')) return {rows:[{email:'rep@example.test',pipedrive_sender_id:7}]};
      if(sql.includes('INSERT INTO sdr_inbox_reply_log')) return {rows:[{gmail_message_id:'incoming'}]};
      if(sql.includes('FROM sdr_lead_state')) {
        const colleague=args[0].includes('colleague@buyer.test');
        return {rows:[{pipedrive_lead_id:colleague?'lead-colleague':'lead-buyer',lead_title:colleague?'Project B':'Project A',person_email:colleague?'colleague@buyer.test':'buyer@buyer.test'}]};
      }
      if(sql.includes("UPDATE sdr_sends SET status = 'replied'")) return {rows:[{apollo_contact_id:args[0]==='lead-buyer'?'contact-buyer':'contact-colleague',apollo_sequence_id:'sequence'}]};
      return {rows:[]};
    })};
    const overview=(await listThreads('fixture-token'))[0];
    await pollInboxReplies(pool,{featureEnabled:false,getToken:async()=>'fixture-token'});
    expect(apollo.removeContactsFromSequence).toHaveBeenCalledWith('sequence',['contact-buyer'],'remove');
    expect(pipedrive.addActivity).toHaveBeenCalledWith(expect.objectContaining({leadId:'lead-buyer'}));
    expect(overview.participants).not.toContain('colleague@buyer.test');
    expect(overview.ccParticipants).toContain('colleague@buyer.test');
  });
});
