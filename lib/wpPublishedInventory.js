// Read a complete published-only snapshot before allowing any app reconciliation.
export async function fetchPublishedWordpressPosts(fetchImpl=fetch){
 const fail=()=>{throw Object.assign(Error('WordPress inventory is incomplete. No articles were changed.'),{status:502});};
 const count=value=>typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
 const posts=[],ids=new Set();let total,pages;
 for(let page=1;page<=(pages??1);page++){
  let response,batch;
  try{
   response=await fetchImpl(`https://proswppp.com/wp-json/wp/v2/posts?status=publish&per_page=100&page=${page}&_fields=id,status,title,slug,date,date_gmt,link,categories,content`,{signal:AbortSignal.timeout(15000)});
   if(!response.ok)return fail();
   batch=await response.json();
  }catch{return fail();}
  const currentTotal=count(response.headers.get('x-wp-total')),currentPages=count(response.headers.get('x-wp-totalpages'));
  if(currentTotal===null||currentPages===null||currentPages!==Math.ceil(currentTotal/100)||currentPages>100)return fail();
  if(page===1){total=currentTotal;pages=currentPages;}
  if(currentTotal!==total||currentPages!==pages||!Array.isArray(batch)||batch.length!==Math.min(100,total-(page-1)*100))return fail();
  for(const post of batch){
   let url;try{url=new URL(post?.link);}catch{return fail();}
   if(!Number.isSafeInteger(post.id)||post.id<=0||ids.has(post.id)||post.status!=='publish'||
    typeof post.title?.rendered!=='string'||!post.title.rendered.trim()||typeof post.content?.rendered!=='string'||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(post.date_gmt||'')||!Number.isFinite(Date.parse(post.date_gmt+'Z'))||
    url.protocol!=='https:'||url.hostname!=='proswppp.com'||url.username||url.password)return fail();
   ids.add(post.id);posts.push(post);
  }
 }
 if(posts.length!==total)return fail();
 return posts;
}
