(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.AxonGraph=factory();})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const states={unknown:'Состояние неизвестно',started:'Ход начат',tool:'Вызван инструмент',completed:'Ход завершён',interrupted:'Ход прерван',error:'Ошибка'};
  function visibleAgents(agents,showInternal){
    if(showInternal)return agents.slice();
    const hidden=new Set(agents.filter(a=>a.internal).map(a=>a.id));
    let changed=true;
    while(changed){changed=false;for(const a of agents)if(hidden.has(a.parentId)&&!hidden.has(a.id)){hidden.add(a.id);changed=true;}}
    return agents.filter(a=>!hidden.has(a.id));
  }
  function sessionGroups(snapshot,showInternal){
    const counts=new Map();
    for(const a of visibleAgents(snapshot.agents||[],showInternal))counts.set(a.rootId,(counts.get(a.rootId)||0)+1);
    return (snapshot.sessions||[]).filter(s=>counts.has(s.id)).map(s=>({...s,agentCount:counts.get(s.id)})).sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)||a.id.localeCompare(b.id));
  }
  function chooseSession(sessions,current,followLatest){if(!followLatest&&current)return current;return sessions[0]?.id||current||null;}
  function describe(agent,now=Date.now()){
    const stamp=Date.parse(agent.lastEventAt);
    const stale=agent.freshness==='stale'||(Number.isFinite(stamp)&&now-stamp>45000);
    return {state:states[agent.state]||states.unknown,freshness:stale?'Нет свежих событий':agent.freshness==='recent'?'Недавнее событие':'Свежесть неизвестна',stale};
  }
  function createEventTracker(capacity=2400){
    let initial=true;const seen=new Set();
    return events=>{
      const fresh=[];
      for(const e of events){if(!initial&&!seen.has(e.id))fresh.push(e);seen.delete(e.id);seen.add(e.id);}
      // Refresh IDs in the retained snapshot before evicting older history.
      const limit=Math.max(1,capacity,events.length);
      while(seen.size>limit)seen.delete(seen.values().next().value);
      initial=false;return fresh;
    };
  }
  function* placementSlots(){
    // Elliptical shells grow in opposite pairs. Each shell has a slight phase
    // shift so the network keeps an organic silhouette without moving caches.
    for(let ring=1;;ring++){
      const rx=450+(ring-1)*300,ry=260+(ring-1)*180,pairs=6+(ring-1)*4;
      const phase=-Math.PI*.82+(ring-1)*.137;
      for(let pair=0;pair<pairs;pair++){
        const a=phase+pair*Math.PI/pairs;
        const x=Math.round(Math.cos(a)*rx),y=Math.round(Math.sin(a)*ry);
        yield [x,y];yield [-x,-y];
      }
    }
  }
  function layout(agents,{cache=new Map(),collapsedIds=[]}={}){
    const unique=new Map();for(const a of agents)if(a&&typeof a.id==='string')unique.set(a.id,a);
    for(const id of cache.keys())if(!unique.has(id))cache.delete(id);
    const sorted=[...unique.values()].sort((a,b)=>(a.depth||0)-(b.depth||0)||a.id.localeCompare(b.id));
    const anchor=sorted.find(a=>!a.parentId&&a.id===a.rootId);
    // Children can be discovered first. Their slots always reserve this origin.
    if(anchor)cache.set(anchor.id,{id:anchor.id,x:0,y:0,width:304,height:320});
    const occupied=[...cache.entries()].filter(([id])=>unique.has(id)).map(([,v])=>v);
    if(!anchor)occupied.push({x:0,y:0,width:304,height:320});
    const overlaps=n=>occupied.some(p=>Math.abs(n.x-p.x)<(n.width+p.width)/2+28&&Math.abs(n.y-p.y)<(n.height+p.height)/2+28);
    for(const a of sorted){
      if(cache.has(a.id))continue;
      const isRoot=!a.parentId&&a.id===a.rootId;
      let n={id:a.id,x:0,y:0,width:isRoot?304:216,height:isRoot?320:88};
      let attempts=0,placed=false;
      for(const [x,y] of placementSlots()){
        n.x=x;n.y=y;
        if(!overlaps(n)){placed=true;break;}
        if(++attempts===10000)break;
      }
      if(!placed){n.x=Math.max(0,...occupied.map(p=>p.x+p.width/2))+n.width/2+28;n.y=0;}
      cache.set(a.id,n);occupied.push(n);
    }
    const collapsed=new Set(collapsedIds);
    const hidden=new Set();
    for(const a of sorted){let p=a.parentId;const visited=new Set([a.id]);while(p&&unique.has(p)&&!visited.has(p)){if(collapsed.has(p)){hidden.add(a.id);break;}visited.add(p);p=unique.get(p).parentId;}}
    const nodes=sorted.filter(a=>!hidden.has(a.id)).map(a=>({...cache.get(a.id)}));
    const shown=new Set(nodes.map(n=>n.id));
    const edges=sorted.filter(a=>shown.has(a.id)&&shown.has(a.parentId)&&a.id!==a.parentId).map(a=>({from:a.parentId,to:a.id}));
    const minX=nodes.length?Math.min(...nodes.map(n=>n.x-n.width/2)):0;
    const minY=nodes.length?Math.min(...nodes.map(n=>n.y-n.height/2)):0;
    const maxX=nodes.length?Math.max(...nodes.map(n=>n.x+n.width/2)):0;
    const maxY=nodes.length?Math.max(...nodes.map(n=>n.y+n.height/2)):0;
    return {nodes,edges,bounds:{x:minX,y:minY,width:maxX-minX,height:maxY-minY}};
  }
  function fitCamera(bounds,width,height,padding=50){
    const scale=Math.max(.02,Math.min(1.15,Math.max(1,width-padding*2)/Math.max(1,bounds.width),Math.max(1,height-padding*2)/Math.max(1,bounds.height)));
    return {scale,x:width/2-(bounds.x+bounds.width/2)*scale,y:height/2-(bounds.y+bounds.height/2)*scale};
  }
  return {layout,visibleAgents,sessionGroups,chooseSession,describe,createEventTracker,fitCamera};
});
