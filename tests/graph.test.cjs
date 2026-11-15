const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../src/Axon.Desktop/Web/graph.js');
const agent=(id,parentId=null,extra={})=>({id,parentId,rootId:'r',name:id,path:id,depth:parentId?1:0,state:'unknown',freshness:'unknown',lastEventAt:null,lastTool:null,internal:false,toolCount:0,...extra});
const tree=[agent('r'),agent('a','r'),agent('b','r'),agent('c','a',{depth:2})];
test('layout is deterministic despite source ordering',()=>assert.deepEqual(G.layout(tree).nodes,G.layout([...tree].reverse()).nodes));
test('only confirmed parent relations become edges',()=>{const l=G.layout([...tree,agent('orphan','missing')]);assert.deepEqual(l.edges.map(e=>[e.from,e.to]).sort(),[['r','a'],['r','b'],['a','c']].sort());});
test('collapse hides descendants but retains branch and stable coordinates',()=>{const cache=new Map();const a=G.layout(tree,{cache});const b=G.layout(tree,{cache,collapsedIds:['a']});assert.deepEqual(b.nodes.map(n=>n.id).sort(),['a','b','r']);assert.deepEqual(b.nodes.find(n=>n.id==='a'),a.nodes.find(n=>n.id==='a'));assert.deepEqual(G.layout(tree,{cache}).nodes,a.nodes);});
test('new child insertion cannot move existing cached agents',()=>{const cache=new Map();const a=G.layout(tree,{cache});const b=G.layout([...tree,agent('0-new','r')],{cache});for(const n of a.nodes)assert.deepEqual(b.nodes.find(x=>x.id===n.id),n);});
test('late root stays at the reserved center while children keep their positions',()=>{
  const children=Array.from({length:20},(_,i)=>agent('child'+String(i).padStart(2,'0'),'r'));
  const cache=new Map(),before=G.layout(children,{cache}),after=G.layout([agent('r'),...children],{cache});
  const root=after.nodes.find(n=>n.id==='r');assert.equal(root.x,0);assert.equal(root.y,0);
  for(const node of before.nodes)assert.deepEqual(after.nodes.find(n=>n.id===node.id),node);
  for(const direction of [n=>n.x<root.x,n=>n.x>root.x,n=>n.y<root.y,n=>n.y>root.y])
    assert.ok(after.nodes.filter(n=>n.id!=='r'&&direction(n)).length>=4,'children should surround the late root');
});
test('cached displaced root returns to center without moving other agents',()=>{
  const cache=new Map([['r',{id:'r',x:960,y:-58,width:196,height:194}],['a',{id:'a',x:-320,y:-174,width:216,height:88}],['b',{id:'b',x:320,y:174,width:216,height:88}]]);
  const saved=[cache.get('a'),cache.get('b')].map(n=>({...n}));
  const result=G.layout([agent('r'),agent('a','r'),agent('b','r')],{cache});
  assert.deepEqual(result.nodes.find(n=>n.id==='r'),{id:'r',x:0,y:0,width:304,height:320});
  for(const n of saved)assert.deepEqual(result.nodes.find(p=>p.id===n.id),n);
});
test('large constellation expands vertically and horizontally rather than into a strip',()=>{
  const nodes=[agent('r'),...Array.from({length:99},(_,i)=>agent('agent'+String(i).padStart(2,'0'),'r'))];
  const result=G.layout(nodes),ratio=result.bounds.width/result.bounds.height;
  assert.ok(ratio>=.75&&ratio<=3.5,'balanced constellation aspect ratio: '+ratio);
  const quadrants=[0,0,0,0];for(const n of result.nodes)if(n.id!=='r'&&n.x!==0&&n.y!==0)quadrants[(n.x>0?1:0)+(n.y>0?2:0)]++;
  assert.ok(quadrants.every(count=>count>=10),'all quadrants should grow: '+quadrants);
});
test('ordinary seven-child constellation uses compact bounds before camera fit',()=>{const nodes=[agent('r'),...Array.from({length:7},(_,i)=>agent('child'+i,'r')),agent('deep','child0',{depth:2})];const l=G.layout(nodes);assert.ok(l.bounds.width<=1150&&l.bounds.height<=700,JSON.stringify(l.bounds));});
test('neural constellation has varied radial positions rather than repeated grid columns',()=>{
  const l=G.layout([agent('r'),...Array.from({length:20},(_,i)=>agent('radial'+String(i).padStart(2,'0'),'r'))]);
  const children=l.nodes.filter(n=>n.id!=='r');
  assert.ok(new Set(children.map(n=>Math.round(n.x))).size>=12,'distinct horizontal positions');
  assert.ok(new Set(children.map(n=>Math.round(n.y))).size>=12,'distinct vertical positions');
});
test('100 agents have finite non-overlapping bounds and are all inspectable',()=>{const nodes=Array.from({length:100},(_,i)=>agent(i?'n'+i:'r',i?(i<10?'r':'n'+Math.floor(i/10)):null,{depth:i?Math.ceil(i/10):0}));const l=G.layout(nodes);assert.equal(l.nodes.length,100);for(const n of l.nodes){assert.ok(Number.isFinite(n.x)&&Number.isFinite(n.y));for(const m of l.nodes)if(n.id!==m.id)assert.ok(Math.abs(n.x-m.x)>=(n.width+m.width)/2+10||Math.abs(n.y-m.y)>=(n.height+m.height)/2+10,`${n.id} overlaps ${m.id}`);}assert.ok(l.bounds.width>0&&Number.isFinite(l.bounds.height));});
test('cycles and missing parents never cause recursion failure',()=>{assert.equal(G.layout([agent('a','b'),agent('b','a'),agent('o','missing')],{collapsedIds:['a']}).nodes.length,2);assert.equal(G.layout([]).nodes.length,0);});
test('internal agents and all descendants are hidden consistently',()=>{const all=[...tree,agent('i','r',{internal:true}),agent('j','i'),agent('k','j')];assert.deepEqual(G.visibleAgents(all,false).map(a=>a.id),['r','a','b','c']);assert.equal(G.visibleAgents(all,true).length,7);});
test('internal-only sessions disappear and badges count visible agents',()=>{const snapshot={sessions:[{id:'r',title:'R',agentCount:9},{id:'i',title:'I',agentCount:1}],agents:[...tree,agent('i',null,{rootId:'i',internal:true})]};assert.deepEqual(G.sessionGroups(snapshot,false).map(s=>[s.id,s.agentCount]),[['r',4]]);});
test('session choice stays pinned unless followLatest is explicitly enabled',()=>{const sessions=[{id:'new'},{id:'old'}];assert.equal(G.chooseSession(sessions,'old',false),'old');assert.equal(G.chooseSession(sessions,'old',true),'new');assert.equal(G.chooseSession(sessions,null,false),'new');assert.equal(G.chooseSession([],null,false),null);});
test('saved chat survives settings arriving before the first history scan',()=>assert.equal(G.chooseSession([],'saved-chat',false),'saved-chat'));
test('saved chat survives nonempty partial discovery until it arrives',()=>{let selected='saved';selected=G.chooseSession([{id:'other'}],selected,false);assert.equal(selected,'saved');assert.equal(G.chooseSession([{id:'saved'},{id:'other'}],selected,false),'saved');assert.equal(G.chooseSession([{id:'other'}],selected,true),'other');assert.equal(G.chooseSession([{id:'new-source'}],null,false),'new-source');});
test('event replay memory evicts old history while repeated recent events stay suppressed',()=>{const track=G.createEventTracker(4);assert.deepEqual(track([{id:'old'},{id:'keep'}]),[]);assert.deepEqual(track([{id:'keep'},{id:'a'},{id:'b'}]).map(e=>e.id),['a','b']);assert.deepEqual(track([{id:'keep'},{id:'b'},{id:'c'}]).map(e=>e.id),['c']);assert.deepEqual(track([{id:'keep'},{id:'c'},{id:'d'}]).map(e=>e.id),['d']);assert.deepEqual(track([{id:'keep'},{id:'d'},{id:'old'}]).map(e=>e.id),['old']);assert.deepEqual(track([{id:'old'},{id:'keep'}]),[]);});
test('removed nodes release their cached slots while current collapsed nodes retain positions',()=>{const cache=new Map();const before=G.layout(tree,{cache});G.layout([agent('r'),agent('b','r'),agent('c','a',{depth:2})],{cache,collapsedIds:['r']});assert.equal(cache.has('a'),false);assert.deepEqual(cache.get('c'),before.nodes.find(n=>n.id==='c'));const after=G.layout([agent('r'),agent('b','r'),agent('c','a',{depth:2}),agent('replacement','r')],{cache});assert.deepEqual(after.nodes.find(n=>n.id==='b'),before.nodes.find(n=>n.id==='b'));assert.equal(after.nodes.find(n=>n.id==='replacement').x,before.nodes.find(n=>n.id==='a').x);assert.equal(after.nodes.find(n=>n.id==='replacement').y,before.nodes.find(n=>n.id==='a').y);});
test('initial history and reordered snapshots never replay event pulses',()=>{const track=G.createEventTracker();assert.deepEqual(track([{id:'a'},{id:'b'}]),[]);assert.deepEqual(track([{id:'b'},{id:'a'},{id:'c'}]).map(e=>e.id),['c']);assert.deepEqual(track([{id:'c'}]),[]);assert.deepEqual(track([{id:'a'},{id:'c'}]),[]);});
test('stale freshness overrides recent scan time without changing state',()=>{const a=agent('r',null,{state:'started',freshness:'stale',lastEventAt:'2026-11-14T10:00:00Z'});const d=G.describe(a,Date.parse('2026-11-14T10:05:00Z'));assert.equal(d.state,'Ход начат');assert.equal(d.freshness,'Нет свежих событий');});
test('elapsed last agent event becomes stale even between scans',()=>{const d=G.describe(agent('r',null,{freshness:'recent',lastEventAt:'2026-11-14T10:00:00Z'}),Date.parse('2026-11-14T10:00:46Z'));assert.equal(d.freshness,'Нет свежих событий');});
test('fit camera accounts for negative graph bounds and preserves padding',()=>{const c=G.fitCamera({x:-400,y:-100,width:1000,height:600},800,500,40);assert.ok(c.scale>0&&c.scale<=1);assert.ok(-400*c.scale+c.x>=39);assert.ok((-100)*c.scale+c.y>=39);assert.ok(600*c.scale+c.x<=761);assert.ok(500*c.scale+c.y<=461);});
