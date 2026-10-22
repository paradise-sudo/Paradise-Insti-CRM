const {initializeApp,applicationDefault,cert}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const fs=require('fs'),path=require('path');
const KEY=path.join(__dirname,'serviceAccountKey.json');
let pid;try{pid=JSON.parse(fs.readFileSync(path.join(__dirname,'..','.firebaserc'),'utf8')).projects.default;}catch(e){}
pid=pid||process.env.GOOGLE_CLOUD_PROJECT;
initializeApp(fs.existsSync(KEY)?{credential:cert(require(KEY)),projectId:pid}
                                :{credential:applicationDefault(),projectId:pid});
const db=getFirestore();
(async()=>{
  const inr=n=>'Rs '+Math.round(n).toLocaleString('en-IN');
  const o=await db.collection('orders').get();
  let fy=0,fv=0,oc=0,ov=0,pre=0;const samples=[];
  o.forEach(d=>{const x=d.data();const t=String(x.orderDate||'').slice(0,10);
    if(samples.length<3)samples.push(String(x.orderDate));
    if(t>='2026-04-01'){fy++;fv+=x.value||0;}else{pre++;}
    if(t>='2026-10-01'&&t<='2026-10-31'){oc++;ov+=x.value||0;}});
  const a=await db.collection('activities').get();
  const t=await db.collection('targets').get();
  console.log('project    :',pid);
  console.log('orders     :',o.size,' (pre-FY27 '+pre+', FY27 '+fy+')');
  console.log('FY27 value :',inr(fv));
  console.log('October    :',oc,'orders,',inr(ov));
  console.log('activities :',a.size);
  console.log('targets    :',t.size);
  console.log('date shape :',samples.join(' | ')||'(no orders at all)');
  console.log('');
  if(fy===0)console.log('>> FY27 is EMPTY. The reset ran and the load did not. Fix:\n'+
    '   cd ~/Paradise-Insti-CRM/seed && python3 build_seed.py && node load_seed.js');
  else if(oc===0)console.log('>> FY27 has data but October has none - check the date shape above.');
  else console.log('>> Data is there. If the screen still reads 0, it is the browser: hard refresh.');
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
