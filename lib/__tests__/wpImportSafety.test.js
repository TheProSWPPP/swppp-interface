import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
let fetchPublishedWordpressPosts;
try{({fetchPublishedWordpressPosts}=await import('../wpPublishedInventory.js'));}catch{}
const post=id=>({id,status:'publish',title:{rendered:`Article ${id}`},slug:`article-${id}`,date:'2026-11-16T12:00:00',date_gmt:'2026-11-16T12:00:00',link:`https://proswppp.com/article-${id}/`,categories:[],content:{rendered:'Article body'}});
const response=(data,total=data.length,pages=Math.ceil(total/100))=>({ok:true,status:200,headers:new Headers({'x-wp-total':String(total),'x-wp-totalpages':String(pages)}),json:async()=>data});
afterEach(()=>vi.unstubAllEnvs());
async function invoke(responses,existing=[]){
 vi.stubEnv('DATABASE_URL','fixture');let handler,index=0,code=200,body;const writes=[],urls=[];
 const fetchImpl=async(url)=>{urls.push(String(url));const r=responses[index++];if(r instanceof Error)throw r;return r||{ok:false,status:400};};
 const pool={query:async(sql,args)=>{
  if(/^(UPDATE|INSERT|DELETE)/.test(sql)){writes.push({sql,args});return {rows:[]};}
  if(sql.includes('WHERE id = $1 OR'))return {rows:existing.filter(x=>x.id===args[0]||x.wordpress_post_id===args[1])};
  return {rows:existing};
 }};
 const source=readFileSync(new URL('../../server.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('app.post("/api/ai-content/import-wp"'),source.indexOf('// Owner-supplied facts for the AI writer'));
 new Function('app','pool','fetch','memoryContent','fetchPublishedWordpressPosts',block)({post:(_path,fn)=>{handler=fn;}},pool,fetchImpl,[],fetchPublishedWordpressPosts);
 const res={status:n=>{code=n;return res;},json:x=>{body=x;}};await handler({},res);
 return {code,body,writes,reads:index,urls};
}
it('does not write anything when the first WordPress page fails',async()=>{
 const r=await invoke([{ok:false,status:403}],[{id:'saved',wordpress_post_id:99,status:'published'}]);
 expect(r.code).toBe(502);expect(r.writes).toEqual([]);
});
it('does not write anything when a later page fails',async()=>{
 const r=await invoke([response(Array.from({length:100},(_,i)=>post(i+1)),101,2),{ok:false,status:503}]);
 expect(r.code).toBe(502);expect(r.writes).toEqual([]);
});
it.each([
 ['missing headers',{...response([post(1)]),headers:new Headers()}],
 ['non-array payload',response({unexpected:true},1,1)],
 ['short page',response([post(1)],101,2)],
 ['duplicate IDs',response([post(1),post(1)],2,1)],
 ['malformed post',response([{...post(1),title:null}])],
 ['wrong status',response([{...post(1),status:'draft'}])],
 ['invalid ID',response([{...post(1),id:'1'}])],
 ['invalid date',response([{...post(1),date_gmt:'invalid'}])],
 ['foreign URL',response([{...post(1),link:'https://other.example/article/'}])],
 ['inconsistent page count',response([post(1)],1,2)],
 ['overlarge inventory',response([post(1)],10001,101)],
])('holds all writes for %s',async(_name,page)=>{
 const r=await invoke([page]);expect(r.code).toBe(502);expect(r.writes).toEqual([]);
});
it('holds all writes when totals change between pages',async()=>{
 const r=await invoke([response(Array.from({length:100},(_,i)=>post(i+1)),101,2),response([post(101),post(102)],102,2)]);
 expect(r.code).toBe(502);expect(r.writes).toEqual([]);
});
it('keeps absent published records and reports them for review',async()=>{
 const r=await invoke([response([post(1)])],[{id:'saved',wordpress_post_id:99,status:'published'}]);
 expect(r.code).toBe(200);expect(r.writes.some(x=>x.sql.startsWith('DELETE'))).toBe(false);
 expect(r.body).toMatchObject({imported:1,trashed:0,missing:1});
});
it('accepts a confirmed empty site without deleting app records',async()=>{
 const r=await invoke([response([],0,0)],[{id:'saved',wordpress_post_id:99,status:'published'}]);
 expect(r.code).toBe(200);expect(r.writes).toEqual([]);expect(r.body.missing).toBe(1);
});
it('reconciles an existing published post using UTC and its canonical URL',async()=>{
 const r=await invoke([response([post(1)])],[{id:'existing',wordpress_post_id:1,status:'draft',wordpress_url:'https://proswppp.com/?p=1'}]);
 expect(r.code).toBe(200);expect(r.body).toMatchObject({imported:0,updated:1,skipped:1,missing:0});
 expect(r.writes).toHaveLength(1);expect(r.writes[0].args).toEqual(['https://proswppp.com/article-1/','2026-11-16T12:00:00Z','existing']);
});
it('stops exactly at the final verified page',async()=>{
 const r=await invoke([response(Array.from({length:100},(_,i)=>post(i+1)),101,2),response([post(101)],101,2)]);
 expect(r.code).toBe(200);expect(r.reads).toBe(2);expect(r.body.total).toBe(101);
 expect(r.urls.map(value=>{const u=new URL(value);return [u.origin,u.searchParams.get('status'),u.searchParams.get('per_page'),u.searchParams.get('page')];})).toEqual([['https://proswppp.com','publish','100','1'],['https://proswppp.com','publish','100','2']]);
});
