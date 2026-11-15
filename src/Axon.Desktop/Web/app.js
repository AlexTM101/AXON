(function(){
  'use strict';
  const G=window.AxonGraph;
  const $=id=>document.getElementById(id);
  const systemMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const settings={codexHome:null,selectedSessionId:null,followLatest:false,reducedMotion:systemMotion.matches,showInternal:false,collapsedIds:[],view:'map',sidebarCollapsed:true,inspectorCollapsed:true,activityCollapsed:true,uiLayoutVersion:2};
  let snapshot=null,selectedAgentId=null,agents=[],events=[],groups=[],graph={nodes:[],edges:[],bounds:{x:0,y:0,width:0,height:0}};
  let camera={x:0,y:0,scale:1},needsFit=true,minimized=false,frame=0,lastFrame=0,activeTab='events',workspaceMode='map',drawerOpen=false;
  let decorativeTime=0,motionLast=null;
  let trackEvents=G.createEventTracker(),sourcePath=null;
  const caches=new Map(),nodeElements=new Map();
  let pulses=[];
  const viewport=$('mapViewport');
  let width=0,height=0,pixelRatio=1;
  const scene=window.AxonScene.create($('canvas'),{invalidate:()=>drawOnce()});
  function send(type,payload){const message={type};if(payload!==undefined)message.payload=payload;window.chrome?.webview?.postMessage(message);}
  function save(){send('saveSettings',{...settings,collapsedIds:[...settings.collapsedIds]});}
  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
  function text(id,value){$(id).textContent=value??'';}
  function dateLabel(value){const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleDateString('ru-RU',{day:'numeric',month:'short'}):'Дата неизвестна';}
  function timeLabel(value){const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';}
  function ageLabel(value){const n=Date.parse(value);if(!Number.isFinite(n))return 'Нет времени события';const seconds=Math.max(0,Math.floor((Date.now()-n)/1000));if(seconds<60)return seconds+' с назад';if(seconds<3600)return Math.floor(seconds/60)+' мин назад';if(seconds<86400)return Math.floor(seconds/3600)+' ч назад';return dateLabel(value);}
  function stateClass(state){return ['started','tool','completed','interrupted','error'].includes(state)?'state-'+state:'';}
  function colorFor(a){return a?.state==='completed'?'#a1d7b5':a?.state==='error'?'#eea0a5':a?.state==='interrupted'?'#f1bd85':a?.state==='started'||a?.state==='tool'?'#7be4e8':'#c4b3f6';}
  function eventLabel(e){const labels={task_started:'Ход начат',task_complete:'Ход завершён',task_completed:'Ход завершён',interrupted:'Ход прерван',task_interrupted:'Ход прерван',tool_started:'Вызван инструмент',tool_completed:'Получен результат инструмента',tool_activity:'Наблюдаемое действие инструмента',agent_activity:'Активность субагента',agent_spawned:'Создан субагент',error:'Ошибка',plan_updated:'Опубликован план'};return Object.hasOwn(labels,e.kind)?labels[e.kind]:e.label;}
  function outcomeLabel(value){const labels={started:'Начат',completed:'Завершён',error:'Ошибка'};return Object.hasOwn(labels,value)?labels[value]:value;}
  function sourceMessage(source){const labels={'Codex folder is unavailable.':'Папка Codex недоступна.','Some local session data could not be read. Retrying automatically.':'Часть локальной истории не удалось прочитать. Повторяем автоматически.'};return Object.hasOwn(labels,source?.message)?labels[source.message]:source?.message;}
  function announce(message){text('announcement',message);}
  function preserveFocus(action){
    const active=document.activeElement,id=active?.id,key=active?.dataset?.focusKey;
    action();
    if(active?.isConnected)return;
    const next=id?$(id):key?[...document.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===key):null;
    next?.focus({preventScroll:true});
  }
  function emptyPane(title,detail){const box=el('div','pane-empty');box.append(el('span','',title));if(detail)box.append(el('p','',detail));return box;}
  function openSettings(){updateSettingsUI();if(!$('settingsDialog').open)$('settingsDialog').showModal();}
  function updateSettingsUI(){
    $('followLatest').checked=settings.followLatest;$('settingsFollow').checked=settings.followLatest;$('reducedMotion').checked=settings.reducedMotion;$('showInternal').checked=settings.showInternal;
    text('sourcePath',snapshot?.source?.path||settings.codexHome||'Папка определяется автоматически');
    const source=snapshot?.source;
    text('sourceDiagnostics',source?(sourceMessage(source)||'Файлов наблюдается: '+source.filesObserved)+(source.malformedLines?' · Пропущено повреждённых строк: '+source.malformedLines:''):'Ожидаем сведения от приложения');
    text('motionToggle',settings.reducedMotion?'Движение уменьшено':'Движение включено');
    $('motionToggle').setAttribute('aria-pressed',String(settings.reducedMotion));
    document.body.classList.toggle('reduced-motion',settings.reducedMotion);
  }
  function renderSource(){
    const s=snapshot?.source,state=s?.state;
    const labels={connected:'Источник доступен',empty:'История пуста',missing:'Папка не найдена',error:'Источник недоступен'};
    text('sourceLabel',labels[state]||'Подключение');
    $('sourceDot').className='dot '+(state==='connected'?'green':state==='missing'||state==='error'?'amber':'');
    const details={connected:'Читаем локальную историю Codex',empty:'Здесь пока нет доступных сеансов',missing:'Выберите папку с историей Codex',error:'Проверьте доступ к локальной папке'};
    text('sourceDetail',sourceMessage(s)||details[state]||'Читаем локальную историю');
    $('sourceDetail').title=s?.path||'';
    updateSettingsUI();
  }
  function renderSessions(){
    const search=$('search').value.toLocaleLowerCase('ru-RU');
    const shown=groups.filter(s=>(s.title||'Без названия').toLocaleLowerCase('ru-RU').includes(search));
    const frag=document.createDocumentFragment();
    for(const s of shown){const b=el('button','session-item'+(s.id===settings.selectedSessionId?' selected':''));b.dataset.focusKey='session:'+s.id;b.setAttribute('aria-current',s.id===settings.selectedSessionId?'true':'false');b.title=s.title||'Без названия';b.append(el('span','session-name',s.title||'Без названия'),el('div','session-meta',s.agentCount+' '+agentWord(s.agentCount)+' · этот сеанс'),el('div','session-date',dateLabel(s.updatedAt)));b.addEventListener('click',()=>chooseSession(s.id));frag.append(b);}
    if(!shown.length)frag.append(el('p','empty-sessions',search?'Чаты не найдены. Попробуйте другое название.':snapshot?'Доступные корневые чаты появятся здесь.':'Читаем историю…'));
    $('sessions').replaceChildren(frag);text('sessionsCount',groups.length);
  }
  function agentWord(count){const last=count%10,n=count%100;return last===1&&n!==11?'агент':last>=2&&last<=4&&(n<12||n>14)?'агента':'агентов';}
  function chooseSession(id){
    if(settings.selectedSessionId===id)return;
    settings.selectedSessionId=id;send("selectHistory",id);settings.followLatest=false;selectedAgentId=null;needsFit=true;pulses=[];save();render();announce('Выбран чат '+(groups.find(s=>s.id===id)?.title||''));
  }
  function chooseAgent(id,focusInspector=true){
    if(!agents.some(a=>a.id===id))return;
    selectedAgentId=id;
    if(revealAgentAncestors(id)){render();save();}
    for(const [key,node] of nodeElements){node.classList.toggle('selected',key===id);node.querySelector('.node-select').setAttribute('aria-pressed',String(key===id));}
    preserveFocus(()=>{renderInspector();renderPlan();renderList($('agentListView'),false);if(activeTab==='roster')renderRoster();});
    if(focusInspector){
      settings.inspectorCollapsed=false;drawerOpen=true;applyLayout();save();
      showSelectedPoint();
    }
    drawOnce();
  }
  function revealAgentAncestors(id){
    const byId=new Map(agents.map(a=>[a.id,a])),ancestors=new Set(),visited=new Set([id]);
    let parent=byId.get(id)?.parentId;
    while(parent&&byId.has(parent)&&!visited.has(parent)){
      ancestors.add(parent);visited.add(parent);parent=byId.get(parent).parentId;
    }
    const collapsed=settings.collapsedIds.filter(id=>!ancestors.has(id));
    if(collapsed.length===settings.collapsedIds.length)return false;
    settings.collapsedIds=collapsed;return true;
  }
  function toggleCollapse(id){
    const collapsed=new Set(settings.collapsedIds);if(collapsed.has(id))collapsed.delete(id);else collapsed.add(id);settings.collapsedIds=[...collapsed];save();render();
  }
  function render(){
    preserveFocus(()=>{
      const previous=settings.selectedSessionId;
      groups=G.sessionGroups(snapshot||{sessions:[],agents:[]},settings.showInternal);
      settings.selectedSessionId=G.chooseSession(groups,settings.selectedSessionId,settings.followLatest);
      if(previous!==settings.selectedSessionId){send("selectHistory",settings.selectedSessionId);needsFit=true;selectedAgentId=null;pulses=[];save();}
      agents=G.visibleAgents(snapshot?.agents||[],settings.showInternal).filter(a=>a.rootId===settings.selectedSessionId);
      const ids=new Set(agents.map(a=>a.id));events=(snapshot?.events||[]).filter(e=>ids.has(e.agentId));
      if(!ids.has(selectedAgentId))selectedAgentId=agents.find(a=>a.id===settings.selectedSessionId)?.id||agents[0]?.id||null;
      renderSource();renderSessions();applyLayout();
      const group=groups.find(s=>s.id===settings.selectedSessionId);
      text('sessionTitle',group?.title||(settings.selectedSessionId?'Выбранный чат пока недоступен':'Выберите чат в панели слева.'));$('sessionTitle').title=group?.title||'';
      text('agentCount',agents.length);text('eventCount',events.length);
      let cache=caches.get(settings.selectedSessionId);if(!cache){cache=new Map();caches.set(settings.selectedSessionId,cache);}
      graph=G.layout(agents,{cache,collapsedIds:settings.collapsedIds});
      renderMap();renderList($('agentListView'),false);renderInspector();renderActivity();setView(settings.view,false);renderEmpty();
      if(needsFit&&width&&height&&graph.nodes.length){fit();needsFit=false;}else applyCamera();
    });
    schedule();
  }
  function renderEmpty(){
    const state=snapshot?.source?.state;
    const empty=agents.length===0;$('mapEmpty').hidden=!empty;$('mapHint').hidden=empty;
    let title='Нет доступных чатов',detail='Откройте чат в Codex или проверьте выбранную папку с историей.';
    if(!snapshot){title='Подключаем локальную историю';detail='Агенты появятся после чтения доступных чатов Codex.';}
    else if(state==='missing'){title='Найдём вашу историю Codex';detail='Папка источника не найдена. Выберите папку Codex для локального наблюдения.';}
    else if(state==='error'){title='Источник временно недоступен';detail=sourceMessage(snapshot.source)||'Проверьте доступ к папке. AXON продолжит пробовать прочитать историю.';}
    else if(state==='empty'){title='Здесь начнётся созвездие';detail='В выбранной папке пока нет доступных сеансов. Откройте чат в Codex или выберите другой источник.';}
    else if(snapshot?.agents?.length&&!groups.length){title='Нет видимых агентов';detail='Доступные сеансы содержат только служебных агентов. Их можно включить в настройках.';}
    else if(settings.selectedSessionId&&!groups.some(s=>s.id===settings.selectedSessionId)){title='Выбранный чат пока недоступен';detail='Сохраняем закреплённый выбор, пока читается история. Чат может отсутствовать в выбранном источнике или быть скрыт фильтром. Выберите другой чат слева или включите переход к последнему чату в настройках.';}
    text('emptyTitle',title);text('emptyText',detail);
    if(!empty&&state==='error'){text('hostMessage','Источник недоступен · показана последняя прочитанная история');}
  }
  function renderMap(){
    const wanted=new Set(graph.nodes.map(n=>n.id));
    for(const [id,node] of nodeElements)if(!wanted.has(id)){node.remove();nodeElements.delete(id);}
    const children=new Map();for(const a of agents)if(a.parentId)children.set(a.parentId,(children.get(a.parentId)||0)+1);
    for(const n of graph.nodes){
      const a=agents.find(a=>a.id===n.id),root=a.id===a.rootId&&!a.parentId;
      let node=nodeElements.get(n.id);
      if(!node){
        node=el('div','map-node');node.dataset.agentId=n.id;const b=el('button','node-select');b.dataset.focusKey='node:'+n.id;b.append(el('span','node-name'),el('span','node-state'));b.addEventListener('click',()=>chooseAgent(n.id));node.append(b);nodeElements.set(n.id,node);$('mapWorld').append(node);
      }
      node.className='map-node'+(root?' root':'')+(n.id===selectedAgentId?' selected':'');node.style.left=n.x+'px';node.style.top=n.y+'px';
      node.querySelector('.node-name').textContent=root?'Codex':a.name||a.path||'Codex';
      const desc=G.describe(a);const state=node.querySelector('.node-state');state.className='node-state '+stateClass(a.state);state.textContent=root?'Главный агент':desc.state.replace('Состояние неизвестно','Неизвестно');
      const b=node.querySelector('.node-select');b.title=(a.name||a.id)+' · '+desc.state+' · '+desc.freshness;b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(n.id===selectedAgentId));
      let collapse=node.querySelector('.node-collapse');
      if(children.has(n.id)){
        if(!collapse){collapse=el('button','node-collapse');collapse.dataset.focusKey='collapse:'+n.id;collapse.addEventListener('click',()=>toggleCollapse(n.id));node.append(collapse);}
        const folded=settings.collapsedIds.includes(n.id);collapse.textContent=folded?'+'+children.get(n.id):'−';collapse.title=folded?'Развернуть ветвь':'Свернуть ветвь';collapse.setAttribute('aria-label',collapse.title+' '+(a.name||a.id));collapse.setAttribute('aria-expanded',String(!folded));
      }else collapse?.remove();
    }
  }
  function renderList(container,compact){
    const top=container.scrollTop;const frag=document.createDocumentFragment();
    if(!agents.length)frag.append(emptyPane('Агенты пока не наблюдались','Выберите доступный чат в панели слева.'));
    for(const a of agents){
      const b=el('button','agent-row'+(compact?' roster-row':'')+(a.id===selectedAgentId?' selected':''));b.dataset.focusKey=(compact?'roster:':'list:')+a.id;b.setAttribute('aria-pressed',String(a.id===selectedAgentId));
      const identity=el('span','');const name=el('span','row-name');const dot=el('i','dot');dot.style.background=colorFor(a);name.append(dot,el('span','',a.name||'Codex'));identity.append(name);if(!compact)identity.append(el('span','row-path',a.path||a.id));
      const desc=G.describe(a);b.append(identity,el('span',stateClass(a.state),desc.state),el('span','row-freshness',desc.stale?'Нет свежих событий':ageLabel(a.lastEventAt)));b.title=(a.path||a.name)+' · '+desc.freshness;b.addEventListener('click',()=>chooseAgent(a.id,true));frag.append(b);
    }
    container.replaceChildren(frag);container.scrollTop=top;
  }
  function renderInspector(){
    const target=$('inspectorContent'),a=agents.find(a=>a.id===selectedAgentId);target.replaceChildren();
    if(!a){target.append(el('p','inspector-empty','Выберите агента на карте или в списке, чтобы увидеть подтверждённые события и связи.'));return;}
    const desc=G.describe(a),pill=el('div','state-pill '+stateClass(a.state));pill.append(el('i','dot'),el('span','',desc.state));
    target.append(el('h2','',a.name||'Codex'),el('div','agent-path',a.path||a.id),pill,el('div','freshness'+(desc.stale?'':' recent'),desc.freshness));
    const activity=el('section','inspector-section');activity.append(el('div','eyebrow','ПОСЛЕДНЯЯ АКТИВНОСТЬ'));
    const latest=events.filter(e=>e.agentId===a.id).sort((x,y)=>Date.parse(y.at)-Date.parse(x.at))[0];
    activity.append(el('p','detail-value strong',latest?eventLabel(latest):'Событий пока не наблюдалось'));
    if(a.lastTool)activity.append(el('p','detail-value','Инструмент: '+a.lastTool));
    activity.append(el('div','detail-time','Последнее событие · '+ageLabel(a.lastEventAt)));
    if(a.lastEventAt){const t=el('div','detail-time',new Date(a.lastEventAt).toLocaleString('ru-RU'));activity.append(t);}
    target.append(activity);
    const links=el('section','inspector-section');links.append(el('div','eyebrow','СВЯЗИ'));
    const parent=agents.find(p=>p.id===a.parentId),parentRow=el('div','detail-grid');parentRow.append(el('span','','Родитель'));
    if(parent){const b=el('button','detail-link',parent.name||parent.id);b.dataset.focusKey='inspector-parent:'+a.id;b.addEventListener('click',()=>chooseAgent(parent.id));parentRow.append(b);}else parentRow.append(el('span','',a.parentId?'Не наблюдался':'Корневой агент'));
    const depth=el('div','detail-grid');depth.append(el('span','','Уровень'),el('span','',a.depth===0?'Главный агент':'Субагент · '+a.depth));
    const count=el('div','detail-grid');count.append(el('span','','Действия'),el('span','',a.toolCount+' · наблюдалось'));
    links.append(parentRow,depth,count);target.append(links);
    const confirmed=el('section','inspector-section');confirmed.append(el('div','eyebrow','ПОДТВЕРЖДЕНО СОБЫТИЯМИ'));
    const labels=[...new Set(events.filter(e=>e.agentId===a.id).slice(-12).map(eventLabel))].slice(-4);
    if(!labels.length)confirmed.append(el('p','detail-value','Нет событий в доступной истории'));
    else for(const label of labels)confirmed.append(el('p','detail-value',label));
    target.append(confirmed);
    if(agents.some(x=>x.parentId===a.id)){const b=el('button','secondary-button',settings.collapsedIds.includes(a.id)?'Развернуть ветвь':'Свернуть ветвь');b.dataset.focusKey='inspector-collapse:'+a.id;b.addEventListener('click',()=>toggleCollapse(a.id));target.append(b);}
  }
  function renderActivity(){
    const pane=$('eventsPane'),top=pane.scrollTop,frag=document.createDocumentFragment();
    const sorted=[...events].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    if(!sorted.length)frag.append(emptyPane('В доступной истории нет событий','Здесь появятся наблюдаемые действия выбранного чата.'));
    for(const e of sorted){
      const a=agents.find(a=>a.id===e.agentId),row=el('div','event-row'),time=el('time','event-time',timeLabel(e.at));time.dateTime=e.at;time.title=new Date(e.at).toLocaleString('ru-RU');
      const name=el('button','event-agent',a?.name||'Агент');name.title=a?.path||a?.name||'';name.dataset.focusKey='event:'+e.id;name.addEventListener('click',()=>chooseAgent(e.agentId,true));
      const label=el('span','event-label',eventLabel(e));if(e.tool&&!String(e.label).includes(e.tool))label.append(el('span','event-outcome',e.tool));if(e.outcome)label.append(el('span','event-outcome',outcomeLabel(e.outcome)));row.append(time,name,label);frag.append(row);
    }
        if(snapshot?.history?.rootId===settings.selectedSessionId){
      const h=snapshot.history;
      if(h.loading)frag.append(el('p','empty-sessions','Загружаем историю…'));
      else if(h.hasMore){const b=el('button','secondary-button','Загрузить более ранние события');b.dataset.focusKey='load-older';b.addEventListener('click',()=>send('loadOlder'));frag.append(b);}
      else if(h.limit>=6000)frag.append(el('p','empty-sessions','Показано не более 6000 событий.'));
    }
    pane.replaceChildren(frag);pane.scrollTop=top;
    text('activityCaption','Локальная история');renderRoster();renderPlan();
  }
  function renderRoster(){renderList($('rosterPane'),true);}
  function renderPlan(){
    const pane=$('planPane'),a=agents.find(a=>a.id===selectedAgentId),steps=snapshot?.plans?.[a?.id]||[];const frag=document.createDocumentFragment();
    if(!steps.length)frag.append(emptyPane('У выбранного агента явный план не опубликован','План содержит только структурированные шаги Codex. Вызовы инструментов показаны во вкладке «События».'));
    else{frag.append(el('div','eyebrow','ОПУБЛИКОВАННЫЙ ПЛАН · '+(a?.name||'Агент')));for(const step of steps){const row=el('div','plan-step'),known=['completed','in_progress','pending'].includes(step.status),symbol=step.status==='completed'?'✓':step.status==='in_progress'?'◉':'○';const copy=el('div','',step.step);copy.append(el('span','plan-status',step.status==='completed'?'Завершён':step.status==='in_progress'?'В процессе':step.status==='pending'?'Предстоит':step.status));row.append(el('span','plan-symbol '+(known?step.status:''),symbol),copy);frag.append(row);}}
    pane.replaceChildren(frag);
  }
  function setTab(name,focus=false,expand=false){
    if(expand&&workspaceMode==='map'&&settings.activityCollapsed){settings.activityCollapsed=false;applyLayout();save();}
    activeTab=name;
    for(const t of ['events','roster','plan']){$(t+'Pane').hidden=t!==name;$(t+'Tab').setAttribute('aria-selected',String(t===name));$(t+'Tab').tabIndex=t===name?0:-1;}
    if(name==='plan')renderPlan();if(focus)$(name+'Tab').focus();
  }
  function setView(view,persist=true){
    settings.view=view==='list'?'list':'map';const list=settings.view==='list';viewport.hidden=list;$('agentListView').hidden=!list;
    if(persist&&!list&&revealAgentAncestors(selectedAgentId))render();
    $('mapView').classList.toggle('selected',!list);$('listView').classList.toggle('selected',list);$('mapView').setAttribute('aria-pressed',String(!list));$('listView').setAttribute('aria-pressed',String(list));
    for(const id of ['fit','zoomIn','zoomOut'])$(id).disabled=list||!graph.nodes.length;
    $('zoomLabel').hidden=list;
    if(persist)save();if(!list){resize();schedule();if(persist)showSelectedPoint();}else pause();
  }
  function applyCamera(){
    const overview=isOverview();$('mapWorld').style.transform='translate('+camera.x+'px,'+camera.y+'px) scale('+camera.scale+')';$('mapWorld').style.setProperty('--map-scale',camera.scale);$('mapWorld').classList.toggle('overview',overview);text('mapHint',overview?'Обзор: увеличьте масштаб или откройте список':'Связи из наблюдаемых событий');text('zoomLabel',Math.round(camera.scale*100)+'%');drawOnce();
  }
  function isOverview(){return camera.scale<.38;}
  function availableMapRect(){
    const rect=viewport.getBoundingClientRect(),inspector=$('inspector'),overlay=inspector.getBoundingClientRect();
    let right=rect.right;
    // The compact drawer overlaps the map; the desktop column does not.
    if(!inspector.hidden&&overlay.left<rect.right&&overlay.right>rect.left&&overlay.top<rect.bottom&&overlay.bottom>rect.top)right=Math.max(rect.left,overlay.left);
    return {x:0,y:0,width:Math.max(0,right-rect.left),height:rect.height};
  }
  function showSelectedPoint(){
    requestAnimationFrame(()=>{
      if(workspaceMode!=='map'||settings.view!=='map')return;
      resize();const n=graph.nodes.find(n=>n.id===selectedAgentId);if(!n)return;
      const area=availableMapRect(),px=n.x*camera.scale+camera.x,py=n.y*camera.scale+camera.y;
      const padX=Math.min(72,area.width/2),padY=Math.min(56,area.height/2);
      camera.x+=Math.min(Math.max(px,area.x+padX),area.x+area.width-padX)-px;
      camera.y+=Math.min(Math.max(py,area.y+padY),area.y+area.height-padY)-py;
      applyCamera();
    });
  }
  function fit(){if(!width||!height)return;const area=availableMapRect();camera=G.fitCamera(graph.bounds,area.width,area.height,height<340?12:26);camera.x+=area.x;camera.y+=area.y;applyCamera();}
  function zoom(factor,x=width/2,y=height/2){const scale=Math.max(.06,Math.min(2.4,camera.scale*factor));const ratio=scale/camera.scale;camera={x:x-(x-camera.x)*ratio,y:y-(y-camera.y)*ratio,scale};applyCamera();}
  function resize(){
    if(viewport.hidden||workspaceMode!=='map')return;
    const oldWidth=width,oldHeight=height;width=viewport.clientWidth;height=viewport.clientHeight;pixelRatio=Math.min(window.devicePixelRatio||1,1.5);
    scene.resize(width,height,pixelRatio);
    if(oldWidth&&oldHeight){camera.x+=(width-oldWidth)/2;camera.y+=(height-oldHeight)/2;}
    if(needsFit&&graph.nodes.length&&width&&height){fit();needsFit=false;}else applyCamera();
  }
  function pause(){if(frame){cancelAnimationFrame(frame);frame=0;}motionLast=null;}
  function canAnimate(){return !settings.reducedMotion&&!minimized&&!document.hidden&&settings.view==='map'&&workspaceMode==='map'&&graph.nodes.length>0;}
  function schedule(){if(canAnimate()){if(!frame)frame=requestAnimationFrame(tick);}else{pause();drawOnce();}}
  function tick(now){
    frame=0;if(!canAnimate()){motionLast=null;return;}
    if(motionLast===null)motionLast=now;
    if(now-lastFrame>=33){decorativeTime+=Math.min(100,Math.max(0,now-motionLast));motionLast=now;draw(now);lastFrame=now;}
    frame=requestAnimationFrame(tick);
  }
  function drawOnce(){if(!minimized&&!document.hidden&&workspaceMode==='map'&&settings.view==='map'&&width&&height)draw(performance.now());}
  function draw(now){
    pulses=pulses.filter(p=>now-p.start<1900);
    scene.draw({graph,agents,rootId:settings.selectedSessionId,selectedAgentId,camera,width,height,pixelRatio,decorativeTime,now,pulses,overview:isOverview(),reducedMotion:settings.reducedMotion});
  }
  let drag=null;
  viewport.addEventListener('pointerdown',e=>{if(e.target.closest('button')||e.button!==0)return;drag={x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y};viewport.setPointerCapture(e.pointerId);});
  viewport.addEventListener('pointermove',e=>{if(!drag)return;camera.x=drag.cx+e.clientX-drag.x;camera.y=drag.cy+e.clientY-drag.y;applyCamera();});
  const stopDrag=()=>{drag=null;};viewport.addEventListener('pointerup',stopDrag);viewport.addEventListener('pointercancel',stopDrag);viewport.addEventListener('lostpointercapture',stopDrag);
  viewport.addEventListener('wheel',e=>{e.preventDefault();const rect=viewport.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0012),e.clientX-rect.left,e.clientY-rect.top);},{passive:false});
  viewport.addEventListener('keydown',e=>{if(e.target!==viewport)return;const move=40;if(e.key==='+'||e.key==='=')zoom(1.15);else if(e.key==='-')zoom(1/1.15);else if(e.key==='Home')fit();else if(e.key==='ArrowLeft')camera.x+=move;else if(e.key==='ArrowRight')camera.x-=move;else if(e.key==='ArrowUp')camera.y+=move;else if(e.key==='ArrowDown')camera.y-=move;else return;e.preventDefault();applyCamera();});
  for(const type of ['minimize','maximize','close'])$(type).addEventListener('click',()=>send(type));
  for(const id of ['settingsOpen','emptyAction'])$(id).addEventListener('click',openSettings);
  $('chooseFolder').addEventListener('click',()=>send('chooseFolder'));$('rescan').addEventListener('click',()=>{send('rescan');text('sourceDiagnostics','Перечитываем локальную историю…');});
  $('settingsDialog').addEventListener('click',e=>{if(e.target===$('settingsDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  $('search').addEventListener('input',renderSessions);
  function setMotion(value){settings.reducedMotion=value;pulses=[];updateSettingsUI();save();schedule();}
  $('motionToggle').addEventListener('click',()=>setMotion(!settings.reducedMotion));$('reducedMotion').addEventListener('change',e=>setMotion(e.target.checked));
  $('showInternal').addEventListener('change',e=>{settings.showInternal=e.target.checked;save();render();});
  for(const id of ['followLatest','settingsFollow'])$(id).addEventListener('change',e=>{settings.followLatest=e.target.checked;save();render();});
  $('mapView').addEventListener('click',()=>setView('map'));$('listView').addEventListener('click',()=>setView('list'));$('fit').addEventListener('click',fit);$('zoomIn').addEventListener('click',()=>zoom(1.2));$('zoomOut').addEventListener('click',()=>zoom(1/1.2));
  for(const name of ['events','roster','plan']){$(name+'Tab').addEventListener('click',()=>setTab(name,false,true));$(name+'Tab').addEventListener('keydown',e=>{const names=['events','roster','plan'],index=names.indexOf(name);if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setTab(names[(index+(e.key==='ArrowRight'?1:2))%3],true,true);}else if(e.key==='Home'){e.preventDefault();setTab('events',true,true);}else if(e.key==='End'){e.preventDefault();setTab('plan',true,true);}});}
  function setWorkspace(mode){
    workspaceMode=mode==='events'?'events':'map';const history=workspaceMode==='events';
    document.querySelector('.workspace').classList.toggle('events-workspace',history);
    document.querySelector('.graph-panel').hidden=history;
    applyLayout();
    text('workspaceTitle',history?'События':'Живая карта');
    for(const [id,active] of [['navEvents',history],['navMap',!history]]){$(id).classList.toggle('active',active);if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}
    if(history){setTab('events',true);$('eventsPane').scrollTop=0;pause();}else{if(settings.view==='map'&&revealAgentAncestors(selectedAgentId)){render();save();}resize();schedule();if(settings.view==='map')showSelectedPoint();(settings.view==='map'?viewport:$('listView')).focus();}
  }
  function applyLayout(){
    const compact=window.innerWidth<1280,inspectorVisible=!settings.inspectorCollapsed&&(!compact||drawerOpen);
    if(!inspectorVisible&&$('inspector').contains(document.activeElement))$('inspectorToggle').focus({preventScroll:true});
    document.querySelector('.app-shell').classList.toggle('sidebar-collapsed',settings.sidebarCollapsed);
    document.querySelector('.app-shell').classList.toggle('inspector-collapsed',settings.inspectorCollapsed);
    const activityExpanded=workspaceMode==='events'||!settings.activityCollapsed;
    document.querySelector('.app-shell').classList.toggle('activity-collapsed',!activityExpanded);
    if($('activityContents'))$('activityContents').hidden=!activityExpanded;
    if($('activityToggle')){$('activityToggle').setAttribute('aria-expanded',String(activityExpanded));$('activityToggle').setAttribute('aria-label',activityExpanded?'Свернуть ленту событий':'Развернуть ленту событий');text('activityToggle',activityExpanded?'⌄':'⌃');}
    $('inspector').hidden=!inspectorVisible;$('inspector').classList.toggle('open',inspectorVisible);
    $('inspectorToggle').setAttribute('aria-expanded',String(inspectorVisible));
    $('inspectorToggle').setAttribute('aria-label',inspectorVisible?'Скрыть панель агента':'Показать панель агента');text('inspectorToggle',inspectorVisible?'Агент ‹':'Агент ›');
    const label=settings.sidebarCollapsed?'Показать рабочее пространство':'Скрыть рабочее пространство';
    $('sidebarToggle').setAttribute('aria-expanded',String(!settings.sidebarCollapsed));$('sidebarToggle').setAttribute('aria-label',label);$('sidebarToggle').title=label;text('sidebarToggle',settings.sidebarCollapsed?'›':'‹');
  }
  function closeInspector(){settings.inspectorCollapsed=true;drawerOpen=false;applyLayout();save();$('inspectorToggle').focus();}
  $('navEvents').addEventListener('click',()=>setWorkspace('events'));$('navMap').addEventListener('click',()=>setWorkspace('map'));
  $('sidebarToggle').addEventListener('click',()=>{settings.sidebarCollapsed=!settings.sidebarCollapsed;applyLayout();save();});
  $('inspectorToggle').addEventListener('click',()=>{if($('inspectorToggle').getAttribute('aria-expanded')==='true')closeInspector();else{settings.inspectorCollapsed=false;drawerOpen=true;applyLayout();save();$('inspectorClose').focus();}});
  $('inspectorClose').addEventListener('click',closeInspector);
  $('activityToggle')?.addEventListener('click',()=>{
    settings.activityCollapsed=!settings.activityCollapsed;
    if(settings.activityCollapsed&&$('activityContents')?.contains(document.activeElement))$('activityToggle').focus();
    applyLayout();save();
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('settingsDialog').open&&!$('inspector').hidden){e.preventDefault();closeInspector();}});
  window.addEventListener('resize',applyLayout);
  systemMotion.addEventListener('change',e=>{if(e.matches)setMotion(true);});
  document.addEventListener('visibilitychange',schedule);new ResizeObserver(resize).observe(viewport);
  function receive(message){
    if(!message||typeof message!=='object')return;
    if(message.type==='snapshot'){
      const payload=message.payload;if(!payload||!Array.isArray(payload.agents)||!Array.isArray(payload.sessions)||!Array.isArray(payload.events))return;
      if(payload.version!==1){text('hostMessage','Версия истории не поддерживается этим интерфейсом');return;}
      if(sourcePath!==payload.source?.path){sourcePath=payload.source?.path;trackEvents=G.createEventTracker();caches.clear();pulses=[];needsFit=true;}
      const roots=new Map();for(const a of payload.agents){if(!roots.has(a.rootId))roots.set(a.rootId,new Set());roots.get(a.rootId).add(a.id);}
      for(const [rootId,cache] of caches){const ids=roots.get(rootId);if(!ids)caches.delete(rootId);else for(const id of cache.keys())if(!ids.has(id))cache.delete(id);}
      const historyChanged = snapshot?.history?.rootId !== payload.history?.rootId || snapshot?.history?.limit !== payload.history?.limit || snapshot?.history?.loading === true; const newEvents=trackEvents(payload.events);snapshot=payload;
      render();
      if(!historyChanged&&!settings.reducedMotion&&!minimized&&payload.source?.state==='connected'){
        const ids=new Set(agents.map(a=>a.id)),now=Date.now();
        for(const e of newEvents)if(ids.has(e.agentId)&&Math.abs(now-Date.parse(e.at))<10000)pulses.push({agentId:e.agentId,start:performance.now()});
        pulses=pulses.slice(-12);
      }
    }else if(message.type==='settings'){
      const p=message.payload||{};
      if((typeof p.codexHome==='string'||p.codexHome===null)&&settings.codexHome!==p.codexHome){snapshot=null;sourcePath=null;trackEvents=G.createEventTracker();caches.clear();pulses=[];selectedAgentId=null;needsFit=true;}
      for(const key of ['followLatest','reducedMotion','showInternal','sidebarCollapsed','inspectorCollapsed','activityCollapsed'])if(typeof p[key]==='boolean')settings[key]=p[key];
      if(typeof p.inspectorCollapsed==='boolean')drawerOpen=!p.inspectorCollapsed;
      if(Number.isInteger(p.uiLayoutVersion))settings.uiLayoutVersion=p.uiLayoutVersion;
      if(typeof p.codexHome==='string'||p.codexHome===null)settings.codexHome=p.codexHome;
      if(typeof p.selectedSessionId==='string'||p.selectedSessionId===null){if(settings.selectedSessionId!==p.selectedSessionId)needsFit=true;settings.selectedSessionId=p.selectedSessionId;}
      if(Array.isArray(p.collapsedIds))settings.collapsedIds=p.collapsedIds.filter(id=>typeof id==='string');
      if(p.view==='map'||p.view==='list')settings.view=p.view;
      render();
    }else if(message.type==='hostStatus'){
      if(typeof message.payload?.minimized==='boolean'){minimized=message.payload.minimized;schedule();}
      if(typeof message.payload?.message==='string')text('hostMessage',message.payload.message);
    }
  }
  window.axonReceive=receive;
  window.axonDiagnostics=()=>({renderer:scene.getDiagnostics(),decorativeTime,eventPulses:pulses.length,animating:!!frame,reducedMotion:settings.reducedMotion,camera:{...camera},viewport:{width,height,pixelRatio}});
  window.addEventListener('pagehide',()=>{pause();scene.dispose();},{once:true});
  // Explicit fixture injection for offline review only; nothing loads or simulates itself.
  window.axonPreview=function(payload){if(window.chrome?.webview)return;$('previewBadge').hidden=false;text('hostMessage','Предпросмотр · тестовые данные, не живое наблюдение');receive({type:'snapshot',payload});};
  window.chrome?.webview?.addEventListener('message',e=>receive(e.data));
  setInterval(()=>{if(!minimized&&!document.hidden&&snapshot){preserveFocus(()=>{renderInspector();renderList($('agentListView'),false);if(activeTab==='roster')renderRoster();});}},5000);
  setTab('events');render();$('navMap').setAttribute('aria-current','page');send('ready');
})();


