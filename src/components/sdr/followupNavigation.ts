export function parentCrmUrl(value:string|null|undefined):string|null{
 if(!value)return null;
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&url.hostname==='proswpppllc.pipedrive.com'&&!url.username&&!url.password&&/^\/(?:leads\/inbox|deal|person|organization)\/[^/]+\/?$/.test(url.pathname)?url.toString():null;
 }catch{return null;}
}

export function leadInboxHref(leadId:string):string{
 return `#/sdr?inboxLead=${encodeURIComponent(leadId)}`;
}
