const WAIT_MS=4000;
export async function connectSnapshotRead(pool){
 let timer,expired=false;
 const connecting=pool.connect();
 try{return await Promise.race([connecting,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('snapshot_timeout'));},WAIT_MS);})]);}
 finally{clearTimeout(timer);if(expired)connecting.then(client=>client.release(),()=>{});}
}
export async function boundedSnapshotRead(promise){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('snapshot_timeout')),WAIT_MS);})]);}
 finally{clearTimeout(timer);}
}
