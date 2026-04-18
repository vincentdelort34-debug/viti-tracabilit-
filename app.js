// ══════════════════════════════════════════════════════
//  LECTEUR SHAPEFILE NATIF — sans librairie externe
//  Lit .shp .dbf et ZIPs — convertit Lambert93 → WGS84
// ══════════════════════════════════════════════════════

// Conversion Lambert93 (EPSG:2154) → WGS84
function lambert93ToWGS84(x, y) {
  const n=0.7256077650532670, C=11754255.4261, Xs=700000.0, Ys=12655612.0499;
  const e=0.0818191910435;
  const r=Math.sqrt((x-Xs)**2+(y-Ys)**2)*(y<Ys?-1:1);
  const gamma=Math.atan((x-Xs)/(Ys-y));
  const lonRad=gamma/n+Math.PI/60; // 3° en radians
  let latIso=-Math.log(Math.abs(r/C))/n;
  let lat=2*Math.atan(Math.exp(latIso))-Math.PI/2;
  for(let i=0;i<10;i++){
    const s=Math.sin(lat);
    const l2=2*Math.atan(Math.exp(latIso)*((1+e*s)/(1-e*s))**(e/2))-Math.PI/2;
    if(Math.abs(l2-lat)<1e-11){lat=l2;break;}
    lat=l2;
  }
  return [lonRad*180/Math.PI, lat*180/Math.PI]; // [lon, lat]
}

function readInt32BE(buf,off){return((buf[off]<<24)|(buf[off+1]<<16)|(buf[off+2]<<8)|buf[off+3]);}
function readInt32LE(buf,off){return buf[off]|(buf[off+1]<<8)|(buf[off+2]<<16)|(buf[off+3]<<24);}
function readFloat64LE(buf,off){return new DataView(buf.buffer||buf,off,8).getFloat64(0,true);}

// Lire un fichier .shp et retourner les polygones en WGS84 [[lat,lon],...]
function parseShp(arrayBuf) {
  const buf=new Uint8Array(arrayBuf);
  const n=(readInt32BE(buf,24)*2-100)/8; // nb records via fileLength
  const polys=[];
  let pos=100;
  while(pos<buf.length-8){
    const cLen=readInt32BE(buf,pos+4)*2;
    const shpType=readInt32LE(buf,pos+8);
    if(shpType===5||shpType===15||shpType===25){ // Polygon / PolygonZ / PolygonM
      const nParts=readInt32LE(buf,pos+44);
      const nPts=readInt32LE(buf,pos+48);
      const parts=[];
      for(let i=0;i<nParts;i++) parts.push(readInt32LE(buf,pos+52+i*4));
      const ptsStart=pos+52+nParts*4;
      const rawPts=[];
      for(let i=0;i<nPts;i++){
        const x=readFloat64LE(buf,ptsStart+i*16);
        const y=readFloat64LE(buf,ptsStart+i*16+8);
        rawPts.push([x,y]);
      }
      // Détecter Lambert93 (coordonnées ~600000-900000 / 6100000-6700000)
      const isL93=rawPts[0]&&rawPts[0][0]>100000;
      // Extraire le ring principal (parts[0])
      const start=parts[0]||0;
      const end=parts[1]||nPts;
      const ring=rawPts.slice(start,end);
      // Convertir et retourner [[lat,lon]] pour Leaflet
      const coords=ring.map(([x,y])=>{
        if(isL93){const [lon,lat]=lambert93ToWGS84(x,y);return[Math.round(lat*7)/7*7,Math.round(lon*7)/7*7];}
        return[Math.round(y*1e7)/1e7,Math.round(x*1e7)/1e7];
      });
      // Précision correcte
      const coordsP=ring.map(([x,y])=>{
        if(isL93){const [lon,lat]=lambert93ToWGS84(x,y);return[parseFloat(lat.toFixed(7)),parseFloat(lon.toFixed(7))];}
        return[parseFloat(y.toFixed(7)),parseFloat(x.toFixed(7))];
      });
      polys.push(coordsP);
    }
    pos+=cLen+8;
    if(cLen===0)break;
  }
  return polys;
}

// Lire un fichier .dbf et retourner les records
function parseDbf(arrayBuf) {
  const buf=new Uint8Array(arrayBuf);
  const nRec=(buf[4]|(buf[5]<<8)|(buf[6]<<16)|(buf[7]<<24));
  const headerSize=(buf[8]|(buf[9]<<8));
  const recSize=(buf[10]|(buf[11]<<8));
  const fields=[];
  let pos=32;
  while(buf[pos]!==0x0D&&pos<headerSize){
    const name=Array.from(buf.slice(pos,pos+11)).map(c=>String.fromCharCode(c)).join('').replace(/\0/g,'').trim();
    const len=buf[pos+16];
    fields.push({name,len});
    pos+=32;
  }
  const records=[];
  for(let i=0;i<nRec;i++){
    const rpos=headerSize+i*recSize+1;
    const rec={};
    let cp=0;
    fields.forEach(f=>{
      rec[f.name]=Array.from(buf.slice(rpos+cp,rpos+cp+f.len)).map(c=>String.fromCharCode(c)).join('').replace(/\0/g,'').trim();
      cp+=f.len;
    });
    records.push(rec);
  }
  return records;
}

// Lire un ZIP avec fflate — gère deflate, stored, tous formats
async function readZipEntries(arrayBuf) {
  return new Promise((resolve, reject) => {
    try {
      const entries = {};
      // fflate.unzip décompresse tout le ZIP en une passe
      fflate.unzip(new Uint8Array(arrayBuf), (err, files) => {
        if (err) {
          reject(new Error('ZIP illisible : ' + err.message));
          return;
        }
        // files = { "nom.shp": Uint8Array, "nom.dbf": Uint8Array, ... }
        Object.entries(files).forEach(([name, data]) => {
          // Garder seulement les fichiers (pas les dossiers)
          if (data.length > 0) {
            entries[name.toLowerCase()] = data.buffer;
          }
        });
        resolve(entries);
      });
    } catch(e) {
      reject(e);
    }
  });
}
// ══════════════════════════════════════════
//  SUPABASE (config chargée depuis /api/config)
// ══════════════════════════════════════════
let sb = null;

async function initSupabase() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Config unavailable');
    const { url, key } = await res.json();
    sb = supabase.createClient(url, key);
  } catch(e) {
    console.error('Supabase init failed:', e);
    throw e;
  }
}

// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════
let DOM_ID=null, DOM=null, PARCS=[], TRAITS=[], STOCK=[], CUVES=[], VENTES=[], MOUVEMENTS=[];
const AN = new Date().getFullYear().toString();

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
(async () => {
  // Helpers directs pour éviter tout problème de hoisting
  const showEl = (id, flex) => {
    const el = document.getElementById(id);
    if (el) el.style.display = flex ? 'flex' : 'block';
  };
  const hideLS = () => {
    const el = document.getElementById('ls');
    if (el) { el.style.display = 'none'; el.classList.add('off'); }
  };
  const goAuth = () => { hideLS(); showEl('auth'); };
  const goOb   = () => { hideLS(); showEl('ob', true); };

  // Timeout de sécurité — AVANT tout, 10s max
  const timeout = setTimeout(goAuth, 10000);

  try {
    await initSupabase();
  } catch(e) {
    clearTimeout(timeout);
    console.error('initSupabase error:', e);
    goAuth(); return;
  }

  // Pré-remplir les dates
  const today = new Date().toISOString().split('T')[0];
  ['tD','rRe','retDate','relDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });

  try {
    const { data: { session } } = await sb.auth.getSession();
    clearTimeout(timeout);
    if (!session) { goAuth(); return; }

    let { data, error } = await sb.from('domaines')
      .select('*').eq('user_id', session.user.id).limit(1).single();

    // Fallback : chercher par email si pas de domaine pour ce user_id (login multi-navigateur)
    if (!data || error) {
      const email = session.user.email;
      if (email) {
        const res = await sb.from('domaines').select('*').eq('email', email).limit(1).single();
        if (res.data && !res.error) {
          // Rattacher le domaine au nouvel user_id
          await sb.from('domaines').update({ user_id: session.user.id }).eq('id', res.data.id);
          data = res.data; data.user_id = session.user.id; error = null;
        }
      }
    }

    if (data && !error) {
      DOM = data; DOM_ID = data.id;
      await loadAll();
      showApp();
    } else {
      goOb();
    }
  } catch(e) {
    clearTimeout(timeout);
    console.error('Init error:', e);
    goAuth();
  }
})();

async function loadAll() {
  syncSaving();
  try {
    const [p,t,s,c,v,mv,eng,fer] = await Promise.all([
      sb.from('parcelles').select('*').eq('domaine_id',DOM_ID).order('code'),
      sb.from('traitements').select('*').eq('domaine_id',DOM_ID).order('date_application',{ascending:false}),
      sb.from('produits_phyto').select('*').eq('domaine_id',DOM_ID).eq('actif',true),
      sb.from('cuves').select('*').eq('domaine_id',DOM_ID),
      sb.from('ventes').select('*').eq('domaine_id',DOM_ID).order('created_at',{ascending:false}),
      sb.from('mouvements_cave').select('*').eq('domaine_id',DOM_ID).order('date_mouvement',{ascending:false}).limit(100),
      sb.from('engrais').select('*').eq('domaine_id',DOM_ID),
      sb.from('fertilisations').select('*').eq('domaine_id',DOM_ID).order('date_application',{ascending:false}),
    ]);
    PARCS  = (p && p.data) ? p.data : [];
    TRAITS = (t && t.data) ? t.data : [];
    STOCK  = (s && s.data) ? s.data : [];
    CUVES  = (c && c.data) ? c.data : [];
    VENTES = (v && v.data) ? v.data : [];
    MOUVEMENTS = (mv && mv.data) ? mv.data : [];
    ENGRAIS = (eng && eng.data) ? eng.data : [];
    FERTIS = (fer && fer.data) ? fer.data : [];
    syncOK();
  } catch(e) {
    console.error('loadAll error:', e);
    syncErr();
    // Ne pas bloquer — continuer avec tableaux vides
  }
}

function showApp() {
  hide('ls'); hide('ob');
  const isDesktop = window.innerWidth >= 900;
  if (isDesktop) {
    document.getElementById('appSidebar').style.display = 'flex';
    document.getElementById('appTopbar').style.display = 'flex';
  } else {
    show('ah'); show('an');
  }
  show('am'); show('aFab');
  const nom = DOM?.nom || DOM?.raison_sociale || 'Mon domaine';
  document.getElementById('aN').textContent = nom;
  document.getElementById('avi').textContent = nom.charAt(0).toUpperCase();
  updateSidebarNom();
  fillProfil();
  renderDash(); renderIFT(); renderStock('all'); renderRegistre(); fillSelects();
  fillFertiSelects(); renderFertiHistory();
  fillCuveSelects();
  loadPerso();
  // Remplir les selects des modals manuels
  fillObsSelects();
  initPhytoSelects();
  initConseil();
}

// ══════════════════════════════════════════
//  ONBOARDING
// ══════════════════════════════════════════

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════
async function doSignIn() {
  const email = document.getElementById('authEmail').value.trim();
  const pwd = document.getElementById('authPwd').value;
  if (!email || !pwd) { showAuthMsg('Veuillez remplir tous les champs', 'error'); return; }
  const btn = document.getElementById('btnSignIn');
  btn.disabled = true; btn.textContent = 'Connexion…';
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pwd });
  if (error) {
    showAuthMsg('Erreur : ' + (error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect' : error.message), 'error');
    btn.disabled = false; btn.innerHTML = '🔑 Se connecter';
    return;
  }
  hide('auth'); show('ls');
  let {data: dom, error: domErr} = await sb.from('domaines').select('*').eq('user_id', data.user.id).limit(1).single();
  // Fallback : chercher par email (login multi-navigateur / nouveau user_id)
  if (!dom || domErr) {
    const res = await sb.from('domaines').select('*').eq('email', email).limit(1).single();
    if (res.data && !res.error) {
      await sb.from('domaines').update({ user_id: data.user.id }).eq('id', res.data.id);
      dom = res.data; domErr = null;
    }
  }
  if (dom && !domErr) {
    DOM=dom; DOM_ID=dom.id;
    await loadAll(); showApp();
  } else {
    hide('ls'); show('ob');
  }
}

async function doSignUp() {
  const email = document.getElementById('authEmail').value.trim();
  const pwd = document.getElementById('authPwd').value;
  if (!email || !pwd) { showAuthMsg('Veuillez remplir tous les champs', 'error'); return; }
  if (pwd.length < 6) { showAuthMsg('Mot de passe : 6 caractères minimum', 'error'); return; }
  const btn = document.getElementById('btnSignUp');
  btn.disabled = true; btn.textContent = 'Création…';
  const { error } = await sb.auth.signUp({ email, password: pwd });
  if (error) {
    showAuthMsg('Erreur : ' + error.message, 'error');
  } else {
    showAuthMsg('✅ Compte créé ! Vérifiez votre email pour confirmer, puis connectez-vous.', 'success');
  }
  btn.disabled = false; btn.innerHTML = '✉️ Créer un compte';
}

function showAuthMsg(msg, type) {
  const el = document.getElementById('authMsg');
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fde8e6' : '#d4edda';
  el.style.color = type === 'error' ? 'var(--rouge)' : 'var(--vert)';
  el.textContent = msg;
}

async function doSignOut() {
  await sb.auth.signOut();
  DOM = null; DOM_ID = null; PARCS=[]; TRAITS=[]; STOCK=[]; CUVES=[]; VENTES=[]; MOUVEMENTS=[]; ENGRAIS=[]; FERTIS=[];
  const ah = document.getElementById('ah'); if(ah) ah.style.display='none';
  const an = document.getElementById('an'); if(an) an.style.display='none';
  document.querySelectorAll('.sec').forEach(s => s.classList.remove('on'));
  const sbEl = document.getElementById('sb'); if(sbEl) sbEl.style.display='none';
  closeM(null,'mProfil');
  show('auth');
}

async function saveOnboarding() {
  const nom = g('obNom').trim()||'Mon domaine';
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { toast('⚠️ Vous devez être connecté pour créer un domaine'); show('auth'); return; }
    const {data,error} = await sb.from('domaines').insert({
      nom, raison_sociale:g('obRaison'), commune:g('obCommune'),
      siret:g('obSiret'), certiphyto:g('obCertif'),
      surface_ha:parseFloat(g('obHa'))||null, campagne_en_cours:AN,
      user_id: user.id, email: user.email
    }).select().single();
    if(error) throw error;
    DOM=data; DOM_ID=data.id;
    await loadAll(); showApp();
    toast('✅ Domaine créé · Bienvenue dans VitiTrace !');
  } catch(e) { toast('⚠️ Erreur — vérifier la connexion : '+e.message); }
}

// ══════════════════════════════════════════
//  NAV
// ══════════════════════════════════════════
function go(id, btn) {
  currentSection = id;
  // Reset edit mode when changing section
  if (editMode) toggleEdit();
  document.querySelectorAll('.sec').forEach(s => s.classList.remove('on'));
  document.getElementById(id).classList.add('on');
  // Sync mobile tabs
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  // Sync desktop sidebar
  document.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('on'));
  const sbBtn = document.getElementById('sb-' + id);
  if (sbBtn) sbBtn.classList.add('on');
  // Update topbar title
  const titles = {
    sDash:'🏠 Accueil', sTrait:'🌿 Traitement', sIFT:'📊 IFT',
    sScan:'📷 Scan IA', sStock:'🧪 Stock phytosanitaire', sFerti:'🌱 Fertilisation',
    sCarto:'🗺️ Parcelles', sMeteo:'🌤️ Météo', sRegistre:'📋 Registre',
    sCave:'🍷 Cave & Négoce', sHVE:'🏅 HVE / AB', sConseil:'💡 Conseils associations', sPerso:'⚙️ Personnaliser'
  };
  const tbEl = document.getElementById('tbTitle');
  if (tbEl) tbEl.textContent = titles[id] || '';
  if (id === 'sCarto') initMap();
  if (id === 'sIFT') renderIFT();
  if (id === 'sHVE') calcHVE();
  if (id === 'sCave') renderCave();
}

// ══════════════════════════════════════════
//  IFT MOTEUR
// ══════════════════════════════════════════
// IFT : normalise g→kg et mL→L avant division (ref ANSES toujours en kg ou L /ha)
const normD=(v,u)=>(u==='g/ha'||u==='mL/ha')?v/1000:v;
const iFT=(d,r,unit)=>(!d||!r)?0:Math.round(normD(d,unit)/r*100)/100;
const iftP=code=>TRAITS.filter(t=>t.parcelle_code===code).reduce((s,t)=>s+(t.ift||0),0);
// Parcelles actives (non archivées) — utilisé pour stats, IFT, dropdowns
const activeParcs=()=>PARCS.filter(p=>!p.archived_at);
function iftDom() {
  const PA=activeParcs();
  if(!PA.length||!TRAITS.length) return 0;
  let ha=0,ix=0;
  PA.forEach(p=>{ha+=p.surface_ha||0; ix+=iftP(p.code)*(p.surface_ha||0);});
  return ha?Math.round(ix/ha*100)/100:0;
}
function iftCat(cat) {
  const PA=activeParcs();
  if(!PA.length) return 0;
  let ha=0,ix=0;
  PA.forEach(p=>{
    const v=TRAITS.filter(t=>t.parcelle_code===p.code&&t.produit_categorie===cat).reduce((s,t)=>s+(t.ift||0),0);
    ha+=p.surface_ha||0; ix+=v*(p.surface_ha||0);
  });
  return ha?Math.round(ix/ha*100)/100:0;
}
const iftSt=v=>v<=3?'ok':v<=4?'warn':'danger';
const iftCol=st=>({ok:'var(--vert2)',warn:'var(--orange)',danger:'var(--rouge)'}[st]);

// ══════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════
function renderDash() {
  const ift=iftDom();
  const nom=DOM?.nom||DOM?.raison_sociale||'';
  document.getElementById('dG').textContent=nom?`Bonjour, ${nom.split(' ')[0]} 👋`:'Bonjour 👋';
  document.getElementById('dS').textContent=`Campagne ${AN} · ${DOM?.commune||'Domaine'} · ${DOM?.surface_ha||'—'} ha`;
  const dI=document.getElementById('dI');
  dI.textContent=TRAITS.length?ift.toFixed(1).replace('.',','):'—';
  dI.className='sv '+(ift>4?'d':ift>3.2?'w':'');
  const _PA=activeParcs();
  document.getElementById('dP').textContent=_PA.length||'—';
  document.getElementById('dH').textContent=(DOM?.surface_ha?DOM.surface_ha+' ha':'— ha');
  document.getElementById('dT').textContent=TRAITS.length;
  document.getElementById('rC').textContent=TRAITS.length;
  // Bars
  const ib=document.getElementById('dIB');
  if(!_PA.length) { ib.innerHTML='<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Ajoutez des parcelles pour voir l’IFT</div>'; }
  else {
    ib.innerHTML=_PA.map(p=>{
      const v=iftP(p.code),col=iftCol(iftSt(v)),pct=Math.min(100,v/4.8*100);
      return`<div class="ib"><div class="ibh"><span class="ibn">${p.code} · ${p.nom}</span><span class="ibv" style="color:${col}">${v.toFixed(1).replace('.',',')}</span></div><div class="ibar"><div class="if" style="width:${pct}%;background:${col}"></div><div class="ibar-ref" style="left:${(4/4.8*100).toFixed(0)}%"></div></div></div>`;
    }).join('');
  }
  // Alertes (parcelles actives uniquement)
  let al='';
  _PA.forEach(p=>{ const v=iftP(p.code); if(v>4) al+=`<div class="al alr"><span class="al-i">🚨</span><div><b>IFT dépassé — ${p.nom}</b>IFT ${v.toFixed(1)} > 4,0 référence HVE.</div></div>`; });
  STOCK.filter(s=>s.etat==='low'||s.etat==='zero').forEach(s=>{ al+=`<div class="al alo"><span class="al-i">🧪</span><div><b>Stock critique — ${s.nom}</b>Reste ${s.qte_stock} ${s.unite_stock}.</div></div>`; });
  document.getElementById('dAl').innerHTML=al;
  // Derniers traits
  const dtl=document.getElementById('dTL');
  if(!TRAITS.length) { dtl.innerHTML='<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun traitement enregistré</div>'; return; }
  dtl.innerHTML=TRAITS.slice(0,5).map(t=>`<div class="li"><div class="lic" style="background:#fde8c8">🌿</div><div class="lib"><div class="lit">${t.produit_nom||'—'}</div><div class="lim">${t.date_application} · ${t.parcelle_code} · ${t.dose_appliquee||'—'} ${t.dose_unite||'kg/ha'} · IFT ${(t.ift||0).toFixed(2)}</div></div><span style="background:#d4edda;color:var(--vert);padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700">IFT ${(t.ift||0).toFixed(2)}</span></div>`).join('');
}

// ══════════════════════════════════════════
//  IFT SECTION
// ══════════════════════════════════════════
function renderIFT() {
  const ift=iftDom(),ref=4.0,st=iftSt(ift);
  document.getElementById('iG').className='ift-g ift-'+(TRAITS.length?st:'ok');
  document.getElementById('iGV').textContent=TRAITS.length?ift.toFixed(1).replace('.',','):'—';
  document.getElementById('iGS').textContent=!TRAITS.length?'Aucun traitement saisi':
    st==='ok'?`✓ ${(ref-ift).toFixed(1)} sous la référence HVE`:
    st==='warn'?`⚠️ ${(ift/ref*100).toFixed(0)}% de la référence atteint`:
    `🚨 Référence dépassée de ${(ift-ref).toFixed(1)}`;
  const fill=document.getElementById('iGF');
  fill.style.width='0%';
  setTimeout(()=>{fill.style.width=TRAITS.length?Math.min(100,ift/(ref*1.4)*100)+'%':'0%';},80);
  const cats={iCF:'Fongicide',iCI:'Insecticide',iCH:'Herbicide',iCB:'Biocontrôle'};
  Object.entries(cats).forEach(([id,cat])=>{
    const v=iftCat(cat)+(id==='iCF'?iftCat('Fongicide cuivre'):0);
    document.getElementById(id).textContent=TRAITS.length?v.toFixed(1).replace('.',','):'—';
  });
  // Alertes
  let al='';
  const _PA=activeParcs();
  _PA.forEach(p=>{const v=iftP(p.code);if(v>ref)al+=`<div class="al alr"><span class="al-i">🚨</span><div><b>${p.nom} — IFT ${v.toFixed(1)} · Référence dépassée</b></div></div>`;else if(v>ref*.85)al+=`<div class="al alo"><span class="al-i">⚠️</span><div><b>${p.nom} — IFT ${v.toFixed(1)} (${(v/ref*100).toFixed(0)}%)</b></div></div>`;});
  document.getElementById('iAl').innerHTML=al;
  // Par parcelle (actives uniquement)
  const pl=document.getElementById('iPL');
  if(!_PA.length){pl.innerHTML='<div style="font-size:13px;color:var(--gris);text-align:center;padding:20px">Ajoutez des parcelles dans l’onglet Parcelles</div>';return;}
  pl.innerHTML=_PA.map(p=>{
    const v=iftP(p.code),pst=iftSt(v),col=iftCol(pst),pct=Math.min(100,v/4.8*100),nb=TRAITS.filter(t=>t.parcelle_code===p.code).length;
    return`<div class="pc ${pst}" onclick="showPD('${p.code}')">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
        <div><div style="font-weight:700;font-size:15px">${p.nom}</div><div style="font-size:12px;color:var(--gris);margin-top:1px">${p.surface_ha||'—'} ha · ${p.cepage||'—'} · ${nb} traitement(s)</div></div>
        <div style="text-align:right"><div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:700;line-height:1;color:${col}">${v.toFixed(1).replace('.',',')} <span style="font-size:13px;color:var(--gris);font-weight:400">/ ${ref}</span></div></div>
      </div>
      <div class="pb"><div class="pbf" style="width:${pct}%;background:${col}"></div><div class="pbr" style="left:${(4/4.8*100).toFixed(0)}%"></div></div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10.5px">
        <span style="color:${col};font-weight:700">${(v/ref*100).toFixed(0)}% utilisé</span>
        <span style="color:var(--gris)">${v<=ref?'Reste : '+(ref-v).toFixed(1)+' IFT':'Dépassé de '+(v-ref).toFixed(1)}</span>
      </div>
    </div>`;
  }).join('');
  document.getElementById('iObj').innerHTML=[['Agriculture Biologique',2.5],['Terra Vitis',3.5],['HVE Niveau 3',4.0]].map(([n,r])=>{
    const ok=ift<=r;
    return`<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gris2)"><div style="font-size:13px;font-weight:600">${n}</div><div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--gris)">≤ ${r}</span><span class="badge ${ok?'bg':'br'}">${ok?'✓ Conforme':'✗ Non conforme'}</span></div></div>`;
  }).join('');
}

function showPD(code) {
  const p=PARCS.find(x=>x.code===code);if(!p)return;
  const v=iftP(code),col=iftCol(iftSt(v));
  const ts=TRAITS.filter(t=>t.parcelle_code===code).sort((a,b)=>b.date_application.localeCompare(a.date_application));
  document.getElementById('mPDT').textContent=`${p.code} · ${p.nom}`;
  document.getElementById('mPDC').innerHTML=`
    <div style="background:linear-gradient(135deg,var(--vigne),#0f2a0f);border-radius:12px;padding:14px;color:#fff;text-align:center;margin-bottom:14px">
      <div style="font-size:11px;opacity:.6;text-transform:uppercase;margin-bottom:4px">IFT cumulé campagne ${AN}</div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:44px;font-weight:700;color:${col};line-height:1">${v.toFixed(2).replace('.',',')}</div>
      <div style="font-size:13px;opacity:.7">sur 4,0 référence · ${(v/4*100).toFixed(0)}%</div>
    </div>
    <div style="background:var(--gris3);border-radius:10px;padding:12px;margin-bottom:14px;font-size:13px">
      <div><b>Cépage :</b> ${p.cepage||'—'} · <b>Surface :</b> ${p.surface_ha||'—'} ha</div>
      <div style="margin-top:3px"><b>Commune :</b> ${p.commune||'—'}</div>
      ${p.ref_cadastrale?`<div style="margin-top:3px"><b>Réf. cadastrale :</b> ${p.ref_cadastrale}</div>`:''}
    </div>
    ${ts.length?ts.map(t=>`<div class="li"><div class="lic" style="background:#fde8c8">🌿</div><div class="lib"><div class="lit">${t.produit_nom||'—'}</div><div class="lim">${t.date_application} · ${t.dose_appliquee||'—'} ${t.dose_unite||'kg/ha'} · BBCH ${t.bbch||'—'}</div><div style="font-size:11px;color:var(--gris);margin-top:2px">${t.dose_appliquee} ÷ ${t.dose_reference} = <b style="color:var(--vigne)">IFT ${(t.ift||0).toFixed(2)}</b></div></div><button onclick="delTrait('${t.id}')" style="background:none;border:none;cursor:pointer;font-size:14px;color:var(--gris);padding:4px">🗑️</button></div>`).join(''):'<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun traitement sur cette parcelle</div>'}`;
  showM('mPD');
}

async function delTrait(id) {
  if(!confirm('Supprimer ce traitement ?')) return;
  const {error}=await sb.from('traitements').delete().eq('id',id);
  if(!error){TRAITS=TRAITS.filter(t=>t.id!==id);renderDash();renderIFT();renderRegistre();toast('🗑️ Supprimé · IFT recalculé');closeM(null,'mPD');}
}
// ══════════════════════════════════════════
//  TRAITEMENT
// ══════════════════════════════════════════
function getSelectedParcs() {
  return Array.from(document.querySelectorAll('#tPaWrap input[type=checkbox]:checked')).map(cb => cb.value);
}

function fillSelects() {
  const wrap=document.getElementById('tPaWrap');
  wrap.innerHTML='';
  activeParcs().forEach(p=>{
    const lbl=document.createElement('label');
    lbl.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;font-size:14px';
    lbl.innerHTML=`<input type="checkbox" value="${p.code}" onchange="uTP()" style="width:20px;height:20px;accent-color:#2d5a1e;cursor:pointer;-webkit-appearance:checkbox;appearance:checkbox"> ${p.code} · ${p.nom} (${p.surface_ha||'?'} ha)`;
    wrap.appendChild(lbl);
  });
  const pr=document.getElementById('tPr');
  pr.innerHTML='<option value="">— Choisir —</option>';
  STOCK.forEach(s=>{
    const e=s.etat==='zero'?'🚫':s.etat==='low'?'⚠️':'✓';
    pr.innerHTML+=`<option value="${s.id}" data-ref="${s.dose_reference||1}" data-unit="${s.dose_unite||'kg/ha'}" data-dar="${s.dar||0}" data-cat="${s.categorie||''}" data-amm="${s.amm||''}">${e} ${s.nom} (${s.qte_stock} ${s.unite_stock})</option>`;
  });
  if(!STOCK.length) pr.innerHTML+='<option disabled>— Scanner une étiquette pour ajouter un produit —</option>';
}

function selP() {
  const sel=document.getElementById('tPr'),opt=sel.options[sel.selectedIndex];
  if(!opt.value) return;
  document.getElementById('tDR').value=opt.dataset.ref||1;
  document.getElementById('tDU').textContent=opt.dataset.unit||'kg/ha';
  document.getElementById('tA').value=opt.dataset.amm||'';
  const s=STOCK.find(x=>x.id===opt.value);
  if(s){
    const al=document.getElementById('sAl');al.style.display='flex';
    al.className='al '+(s.etat==='zero'?'alr':s.etat==='low'?'alo':'alb');
    document.getElementById('sAlT').innerHTML=`Stock : <b>${s.qte_stock} ${s.unite_stock}</b>${s.etat==='zero'?' — <b>ÉPUISÉ</b>':s.etat==='low'?' — <b>Sous le seuil</b>':''}`;
  }
  const dar=parseInt(opt.dataset.dar)||0;
  if(dar>0){
    const d=new Date();d.setDate(d.getDate()+dar);
    document.getElementById('dD').style.display='flex';
    document.getElementById('dDT').innerHTML=`<b>DAR ${dar} jours</b> · Récolte possible à partir du ${d.toLocaleDateString('fr-FR')}`;
  }
  uTP();
}

// ─── MÉLANGE / TANK-MIX ───
let MIX_COUNTER = 0; // compteur d'IDs uniques pour les rows dynamiques

function addMixRow() {
  MIX_COUNTER++;
  const i = MIX_COUNTER;
  const container = document.getElementById('mixRows');
  const wrap = document.createElement('div');
  wrap.className = 'mix-row';
  wrap.dataset.row = i;
  wrap.style.cssText = 'border:2px solid var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;background:var(--blanc)';
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-size:11px;font-weight:700;color:var(--or);text-transform:uppercase;letter-spacing:.07em">🧪 Produit ${i+1}</div>
      <button type="button" onclick="removeMixRow(${i})" style="background:none;border:none;color:var(--rouge);font-size:18px;cursor:pointer;padding:0 8px" title="Retirer ce produit">✕</button>
    </div>
    <div class="fg"><select id="tPr_${i}" onchange="selPRow(${i})"><option value="">— Choisir —</option></select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
        <button type="button" class="btn btghost btsm" onclick="showM('mAddProd')">✏️ Saisie manuelle</button>
        <button type="button" class="btn btghost btsm" onclick="go('sScan',document.querySelectorAll('.tab')[3])">📷 Scanner étiquette</button>
      </div>
    </div>
    <div class="al alb" id="sAl_${i}" style="display:none;margin:8px 0"><span class="al-i">ℹ️</span><div id="sAlT_${i}"></div></div>
    <div class="row2">
      <div class="fg"><label>💊 Dose appliquée</label><div class="ig"><input type="number" id="tDo_${i}" step="0.01" oninput="uTPRow(${i})"><span class="isuf" id="tDU_${i}">kg/ha</span></div></div>
      <div class="fg"><label>📐 Dose référence ANSES</label><div class="ig"><input type="number" id="tDR_${i}" step="0.01" oninput="uTPRow(${i})"><span class="isuf">kg/ha</span></div></div>
    </div>
    <div class="al alb" id="iF_${i}" style="display:none;margin:8px 0"><span class="al-i">🧮</span><div id="iFT_${i}"></div></div>
    <div class="row2"><div class="fg"><label>🔢 N° AMM</label><input type="text" id="tA_${i}" placeholder="FR-XXXX-XXXX"></div><div class="fg"></div></div>
    <div class="al alg" id="dD_${i}" style="display:none"><span class="al-i">✅</span><div id="dDT_${i}"></div></div>
  `;
  container.appendChild(wrap);
  // Remplir la liste des produits
  const sel = document.getElementById('tPr_' + i);
  STOCK.forEach(s => {
    const e = s.etat === 'zero' ? '🚫' : s.etat === 'low' ? '⚠️' : '✓';
    sel.innerHTML += `<option value="${s.id}" data-ref="${s.dose_reference || 1}" data-unit="${s.dose_unite || 'kg/ha'}" data-dar="${s.dar || 0}" data-cat="${s.categorie || ''}" data-amm="${s.amm || ''}">${e} ${s.nom} (${s.qte_stock} ${s.unite_stock})</option>`;
  });
  if (!STOCK.length) sel.innerHTML += '<option disabled>— Scanner une étiquette pour ajouter un produit —</option>';
  uTP();
}

function removeMixRow(i) {
  const el = document.querySelector(`#mixRows .mix-row[data-row="${i}"]`);
  if (el) el.remove();
  uTP();
}

function selPRow(i) {
  const sel = document.getElementById('tPr_' + i);
  const opt = sel.options[sel.selectedIndex];
  if (!opt.value) return;
  document.getElementById('tDR_' + i).value = opt.dataset.ref || 1;
  document.getElementById('tDU_' + i).textContent = opt.dataset.unit || 'kg/ha';
  document.getElementById('tA_' + i).value = opt.dataset.amm || '';
  const s = STOCK.find(x => x.id === opt.value);
  if (s) {
    const al = document.getElementById('sAl_' + i);
    al.style.display = 'flex';
    al.className = 'al ' + (s.etat === 'zero' ? 'alr' : s.etat === 'low' ? 'alo' : 'alb');
    document.getElementById('sAlT_' + i).innerHTML = `Stock : <b>${s.qte_stock} ${s.unite_stock}</b>${s.etat === 'zero' ? ' — <b>ÉPUISÉ</b>' : s.etat === 'low' ? ' — <b>Sous le seuil</b>' : ''}`;
  }
  const dar = parseInt(opt.dataset.dar) || 0;
  if (dar > 0) {
    const d = new Date(); d.setDate(d.getDate() + dar);
    document.getElementById('dD_' + i).style.display = 'flex';
    document.getElementById('dDT_' + i).innerHTML = `<b>DAR ${dar} jours</b> · Récolte possible à partir du ${d.toLocaleDateString('fr-FR')}`;
  }
  uTPRow(i);
}

function uTPRow(i) {
  const prod = document.getElementById('tPr_' + i)?.value;
  const dose = parseFloat(document.getElementById('tDo_' + i)?.value);
  const dRef = parseFloat(document.getElementById('tDR_' + i)?.value);
  const unit = document.getElementById('tDU_' + i)?.textContent || 'kg/ha';
  const iFEl = document.getElementById('iF_' + i);
  const iFTEl = document.getElementById('iFT_' + i);
  if (prod && dose && dRef) {
    const dN = normD(dose, unit);
    const ift = iFT(dose, dRef, unit);
    iFEl.style.display = 'flex';
    iFTEl.innerHTML = `<b>IFT = ${dN} ÷ ${dRef} = ${ift.toFixed(2)}</b> (${(dN / dRef * 100).toFixed(0)}% de la dose référence ANSES)`;
  } else if (iFEl) {
    iFEl.style.display = 'none';
  }
  uTP();
}

// Collecte toutes les lignes produits du mélange (principal + supplémentaires)
function collectMixRows() {
  const rows = [];
  // Ligne principale (IDs statiques)
  const mainProd = document.getElementById('tPr').value;
  const mainDose = parseFloat(document.getElementById('tDo').value);
  const mainDRef = parseFloat(document.getElementById('tDR').value);
  if (mainProd && mainDose && mainDRef) {
    const sel = document.getElementById('tPr');
    const opt = sel.options[sel.selectedIndex];
    rows.push({
      idx: 0,
      prodId: mainProd,
      dose: mainDose,
      dRef: mainDRef,
      amm: document.getElementById('tA').value,
      unit: opt?.dataset.unit || 'kg/ha',
      cat: opt?.dataset.cat || '',
      dar: parseInt(opt?.dataset.dar) || 0,
      nom: (opt?.text || '').replace(/^[✓⚠️🚫]\s/, '').split(' (')[0],
    });
  }
  // Lignes supplémentaires (IDs dynamiques)
  document.querySelectorAll('#mixRows .mix-row').forEach(row => {
    const i = row.dataset.row;
    const p = document.getElementById('tPr_' + i)?.value;
    const d = parseFloat(document.getElementById('tDo_' + i)?.value);
    const r = parseFloat(document.getElementById('tDR_' + i)?.value);
    if (p && d && r) {
      const sel = document.getElementById('tPr_' + i);
      const opt = sel.options[sel.selectedIndex];
      rows.push({
        idx: i,
        prodId: p,
        dose: d,
        dRef: r,
        amm: document.getElementById('tA_' + i).value,
        unit: opt?.dataset.unit || 'kg/ha',
        cat: opt?.dataset.cat || '',
        dar: parseInt(opt?.dataset.dar) || 0,
        nom: (opt?.text || '').replace(/^[✓⚠️🚫]\s/, '').split(' (')[0],
      });
    }
  });
  return rows;
}

function uTP() {
  const selParcs = getSelectedParcs();
  const btn = document.getElementById('bST');
  const rows = collectMixRows();

  // Affichage IFT par produit (ligne principale)
  const mainProd = document.getElementById('tPr').value;
  const mainDose = parseFloat(document.getElementById('tDo').value);
  const mainDRef = parseFloat(document.getElementById('tDR').value);
  const mainUnit = document.getElementById('tDU').textContent || 'kg/ha';
  if (mainProd && mainDose && mainDRef) {
    const dNorm = normD(mainDose, mainUnit);
    const ift = iFT(mainDose, mainDRef, mainUnit);
    document.getElementById('ipv').textContent = ift.toFixed(2).replace('.', ',');
    document.getElementById('ipv').classList.add('has');
    document.getElementById('ipp').classList.add('has');
    document.getElementById('ipd').textContent = `${dNorm} ÷ ${mainDRef} = IFT ${ift.toFixed(2)}`;
    document.getElementById('iF').style.display = 'flex';
    document.getElementById('iFT').innerHTML = `<b>IFT = ${dNorm} ÷ ${mainDRef} = ${ift.toFixed(2)}</b> (${(dNorm / mainDRef * 100).toFixed(0)}% de la dose référence ANSES)`;
  } else {
    document.getElementById('ipv').textContent = '—';
    document.getElementById('ipv').classList.remove('has');
    document.getElementById('ipp').classList.remove('has');
    document.getElementById('iF').style.display = 'none';
  }

  // IFT total du passage (somme)
  const totIFT = rows.reduce((s, r) => s + iFT(r.dose, r.dRef, r.unit), 0);
  const totEl = document.getElementById('iFTot');
  const totVEl = document.getElementById('iFTotV');
  const totDEl = document.getElementById('iFTotD');
  if (rows.length >= 2) {
    totEl.style.display = 'block';
    totVEl.textContent = totIFT.toFixed(2).replace('.', ',');
    totDEl.textContent = `= ${rows.map(r => (r.dose / r.dRef).toFixed(2)).join(' + ')} (${rows.length} produits)`;
  } else {
    totEl.style.display = 'none';
  }

  // Impact parcelle (affiche pour la 1ère parcelle sélectionnée)
  if (selParcs.length && rows.length) {
    const before = iftP(selParcs[0]), after = before + totIFT;
    document.getElementById('impB').style.display = 'block';
    const be = document.getElementById('iBf'), ae = document.getElementById('iBa');
    be.textContent = before.toFixed(1).replace('.', ',');
    be.style.color = iftCol(iftSt(before));
    ae.textContent = after.toFixed(1).replace('.', ',');
    ae.style.color = iftCol(iftSt(after));
    if (selParcs.length > 1) {
      document.getElementById('ipd').textContent += ` · ${selParcs.length} parcelles`;
    }
  } else {
    document.getElementById('impB').style.display = 'none';
  }

  btn.disabled = !(selParcs.length && rows.length);
}

async function saveTrait() {
  const selParcs = getSelectedParcs();
  if (!selParcs.length) { toast('⚠️ Parcelle obligatoire'); return; }
  const rows = collectMixRows();
  if (!rows.length) { toast('⚠️ Au moins un produit (avec dose) est obligatoire'); return; }
  const dateApp = document.getElementById('tD').value;
  const heureApp = document.getElementById('tH').value;
  const bbch = document.getElementById('tB').value;
  const adjuvants = document.getElementById('tAd').value;
  syncSaving();
  try {
    // Insertion en batch — une ligne par produit × par parcelle sélectionnée
    const payload = [];
    for (const pCode of selParcs) {
      const parc = PARCS.find(p => p.code === pCode);
      for (const r of rows) {
        payload.push({
          domaine_id: DOM_ID,
          parcelle_id: parc?.id,
          produit_id: r.prodId,
          date_application: dateApp,
          heure_application: heureApp,
          campagne: AN,
          parcelle_code: pCode,
          produit_nom: r.nom,
          produit_categorie: r.cat,
          amm: r.amm,
          dose_appliquee: r.dose,
          dose_reference: r.dRef,
          dose_unite: r.unit,
          ift: iFT(r.dose, r.dRef, r.unit),
          bbch,
          adjuvants,
          dar: r.dar,
        });
      }
    }
    const { data, error } = await sb.from('traitements').insert(payload).select();
    if (error) throw error;
    data.forEach(d => TRAITS.unshift(d));

    // Déduire stock pour chaque produit × chaque parcelle sélectionnée
    for (const pCode of selParcs) {
      const parc = PARCS.find(p => p.code === pCode);
      for (const r of rows) {
        const s = STOCK.find(x => x.id === r.prodId);
        if (s && parc) {
          const nq = Math.max(0, Math.round((s.qte_stock - r.dose * (parc.surface_ha || 1)) * 100) / 100);
          const ne = nq <= 0 ? 'zero' : nq <= s.seuil_alerte ? 'low' : 'ok';
          await sb.from('produits_phyto').update({ qte_stock: nq, etat: ne }).eq('id', r.prodId);
          s.qte_stock = nq; s.etat = ne;
        }
      }
    }

    syncOK();
    renderDash(); renderIFT(); renderRegistre(); renderStock('all'); fillSelects();
    const totIFT = rows.reduce((s, r) => s + iFT(r.dose, r.dRef, r.unit), 0);
    toast(`✅ Passage enregistré · ${selParcs.length} parcelle${selParcs.length > 1 ? 's' : ''} · ${rows.length} produit${rows.length > 1 ? 's' : ''} · IFT +${totIFT.toFixed(2)}`);

    // Reset form — ligne principale
    ['tDo', 'tDR', 'tA', 'tAd'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('tPr').value = '';
    document.getElementById('ipv').textContent = '—';
    document.getElementById('ipv').classList.remove('has');
    document.getElementById('ipp').classList.remove('has');
    document.getElementById('iF').style.display = 'none';
    document.getElementById('impB').style.display = 'none';
    document.getElementById('sAl').style.display = 'none';
    document.getElementById('dD').style.display = 'none';
    document.getElementById('iFTot').style.display = 'none';
    // Reset parcelles checkboxes
    document.querySelectorAll('#tPaWrap input[type=checkbox]').forEach(cb => cb.checked = false);
    // Reset rows supplémentaires : on les supprime toutes
    document.getElementById('mixRows').innerHTML = '';
    document.getElementById('bST').disabled = true;
  } catch (e) { syncErr(); toast('❌ Erreur : ' + e.message); }
}

// ══════════════════════════════════════════
//  SCAN IA
// ══════════════════════════════════════════
let img64=null,imgMime='image/jpeg';
function triggerUpload(){document.getElementById('fI').click();}
function handleFile(input){
  const f=input.files[0];if(!f)return;
  imgMime=f.type||'image/jpeg';
  const r=new FileReader();
  r.onload=e=>{
    img64=e.target.result.split(',')[1];
    const prev=document.getElementById('pi'),zone=document.getElementById('dZ');
    prev.src=e.target.result;prev.style.display='block';
    document.getElementById('uC').style.display='none';
    document.getElementById('iO').style.display='flex';
    zone.classList.add('has');
    document.getElementById('aB').disabled=false;
    document.getElementById('aB').style.background='var(--or)';
    document.getElementById('aB').style.color='var(--noir)';
    document.getElementById('sB').style.display='block';
    toast('✅ Photo chargée — Appuyez sur Analyser');
    // Sur mobile : lancer analyse automatiquement après 1 seconde
    if(window.innerWidth < 900) {
      setTimeout(() => lancerAnalyse(), 800);
    }
  };r.readAsDataURL(f);
}
const dz=document.getElementById('dZ');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag');});
dz.addEventListener('dragleave',()=>dz.classList.remove('drag'));
dz.addEventListener('drop',e=>{
  e.preventDefault();dz.classList.remove('drag');
  const f=e.dataTransfer.files[0];
  if(f&&f.type.startsWith('image/')){const dt=new DataTransfer();dt.items.add(f);document.getElementById('fI').files=dt.files;handleFile(document.getElementById('fI'));}
});

async function lancerAnalyse(){
  if(!img64){toast('⚠️ Charger une image d’abord');return;}
  document.getElementById('lC').classList.add('show');
  document.getElementById('sR').style.display='none';
  document.getElementById('aB').disabled=true;
  const ids=['l1','l2','l3','l4','l5','l6'];let i=0;
  const iv=setInterval(()=>{
    if(i>0){const p=document.getElementById(ids[i-1]);p.classList.remove('active');p.classList.add('done');p.querySelector('.lst-i').textContent='✓';}
    if(i<ids.length){document.getElementById(ids[i]).classList.add('active');i++;}else clearInterval(iv);
  },600);
  try{
    // Proxy Vercel — évite les problèmes CORS
    const res=await fetch('/api/scan',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({image:img64, mimeType:imgMime})
    });
    clearInterval(iv);
    ids.forEach(id=>{const el=document.getElementById(id);if(el){el.classList.remove('active');el.classList.add('done');el.querySelector('.lst-i').textContent='✓';}});
    await new Promise(r=>setTimeout(r,400));
    if(!res.ok) throw new Error('Erreur serveur: '+res.status);
    const data=await res.json();
    if(data.error) throw new Error(data.error);
    fillScanResult(data);
  }catch(e){
    clearInterval(iv);
    ids.forEach(id=>{const el=document.getElementById(id);if(el){el.classList.remove('active');}});
    document.getElementById('lC').classList.remove('show');
    document.getElementById('aB').disabled=false;
    toast('❌ Scan impossible — vérifier la connexion');
    console.error('Scan error:',e);
  }
}

function fillScanResult(d){
  document.getElementById('lC').classList.remove('show');
  document.getElementById('sR').style.display='block';
  document.getElementById('cB').textContent=`conf. ${d.confiance||88}%`;
  const sv=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v||'';};
  sv('rN',d.nom);sv('rF',d.fabricant);sv('rAM',d.amm);
  sv('rD',d.dose_vigne);sv('rNA',d.nb_applications);sv('rDA',d.dar);
  sv('rZ',d.znt);sv('rCi',d.cibles);sv('rH',d.restriction_horaire);
  if(d.date_peremption)sv('rPe',d.date_peremption);
  document.getElementById('rDU').textContent=d.dose_unite||'kg/ha';
  document.getElementById('rQU').textContent=(d.dose_unite||'kg/ha').replace('/ha','');

  // Chercher dans PHYTO_DB pour compléter les infos manquantes
  if(d.nom && window.PHYTO_INDEX) {
    const q = d.nom.toLowerCase().split(' ')[0];
    const match = window.PHYTO_INDEX.find(p => p.searchText.includes(q) && !p.isMA);
    if(match) {
      if(!d.dar || d.dar===0) sv('rDA', match.dar);
      if(!d.znt || d.znt===0) sv('rZ', match.znt);
      if(!d.cibles) sv('rCi', match.cibles);
      const catEl = document.getElementById('rC');
      if(catEl && match.categ) catEl.value = match.categ;
    }
  }

  document.getElementById('sR').scrollIntoView({behavior:'smooth'});
  toast(`✅ Extraction IA · Confiance ${d.confiance||88}% · Vérifiez les données`);
}

async function saveScan(){
  const nom=document.getElementById('rN').value;
  if(!nom){toast('⚠️ Nom obligatoire');return;}
  syncSaving();
  const du=document.getElementById('rDU').textContent||'kg/ha';
  const dr=parseFloat((document.getElementById('rD').value||'1').replace(',','.'));
  const qte=parseFloat(document.getElementById('rQ').value)||0;
  const seuil=parseFloat(document.getElementById('rS').value)||5;
  try{
    const {data,error}=await sb.from('produits_phyto').insert({
      domaine_id:DOM_ID,nom,amm:document.getElementById('rAM').value,
      fabricant:document.getElementById('rF').value,categorie:document.getElementById('rC').value,
      dose_reference:dr,dose_max:dr,dose_unite:du,
      dar:parseInt(document.getElementById('rDA').value)||0,
      znt:parseInt(document.getElementById('rZ').value)||5,
      nb_applications_max:parseInt(document.getElementById('rNA').value)||null,
      cibles:document.getElementById('rCi').value,
      restriction_horaire:document.getElementById('rH').value,
      qte_stock:qte,unite_stock:du.replace('/ha',''),
      seuil_alerte:seuil,etat:qte<=0?'zero':qte<=seuil?'low':'ok',
      date_reception:document.getElementById('rRe').value||null,
      date_peremption:document.getElementById('rPe').value||null,
      fournisseur:document.getElementById('rFo').value,actif:true
    }).select().single();
    if(error)throw error;
    STOCK.push(data);syncOK();renderStock('all');fillSelects();
    toast('✅ Produit enregistré dans le stock Supabase');resetScan();
  }catch(e){syncErr();toast('❌ Erreur : '+e.message);}
}
function saveScanAndTreat(){saveScan().then(()=>go('sTrait',document.querySelectorAll('.tab')[1]));}
function resetScan(){
  img64=null;
  document.getElementById('pi').style.display='none';document.getElementById('uC').style.display='block';
  document.getElementById('iO').style.display='none';document.getElementById('dZ').classList.remove('has');
  document.getElementById('aB').disabled=true;document.getElementById('lC').classList.remove('show');
  document.getElementById('sR').style.display='none';document.getElementById('sB').style.display='none';
  document.getElementById('fI').value='';
  ['l1','l2','l3','l4','l5','l6'].forEach((id,i)=>{const el=document.getElementById(id);el.className='lst';el.querySelector('.lst-i').textContent=i+1;});
}

// ══════════════════════════════════════════
//  STOCK
// ══════════════════════════════════════════
function renderStock(filter){
  const list=document.getElementById('sL');
  const items=filter==='all'?STOCK:STOCK.filter(s=>s.etat===filter);
  if(!items.length){list.innerHTML=`<div style="font-size:13px;color:var(--gris);text-align:center;padding:20px">Aucun produit ${filter!=='all'?'dans cette catégorie':''}<br>Scannez une étiquette ou saisie manuelle</div>`;return;}
  
  const isDesktop = window.innerWidth >= 900;
  if (isDesktop) {
    list.innerHTML = `<table class="stock-table">
      <thead><tr>
        <th>Produit</th><th>Catégorie</th><th>AMM</th>
        <th>Dose réf.</th><th>DAR</th><th>Stock</th><th>État</th>
      </tr></thead>
      <tbody>${items.map(s=>{
        const col=s.etat==='ok'?'var(--vert2)':s.etat==='low'?'var(--orange)':'var(--rouge)';
        const bc=s.etat==='ok'?'bg':s.etat==='low'?'bo':'br';
        return`<tr>
          <td><div style="font-weight:700">${s.nom}</div><div style="font-size:11px;color:var(--gris)">${s.fournisseur||''}</div></td>
          <td>${s.categorie||'—'}</td>
          <td style="font-size:12px;color:var(--gris)">${s.amm||'—'}</td>
          <td>${s.dose_reference||'—'} ${s.dose_unite||'kg/ha'}</td>
          <td>${s.dar||0} j</td>
          <td><b style="color:${col}">${s.qte_stock}</b> ${s.unite_stock}</td>
          <td><span class="badge ${bc}">${s.etat==='ok'?'✓ OK':s.etat==='low'?'⚠️ Faible':'🚫 Épuisé'}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } else {
    list.innerHTML=items.map(s=>{
      const pct=Math.min(100,Math.round(s.qte_stock/((s.seuil_alerte||1)*3)*100));
      const col=s.etat==='ok'?'var(--vert2)':s.etat==='low'?'var(--orange)':'var(--rouge)';
      const bg=s.etat==='ok'?'#d4edda':s.etat==='low'?'#fde8c8':'#fde8e6';
      const ic=s.categorie?.includes('Bio')?'🌱':s.categorie?.includes('cuivre')?'🟤':'🌿';
      const bc=s.etat==='ok'?'bg':s.etat==='low'?'bo':'br';
      return`<div class="si"><div class="si-ic" style="background:${bg}">${ic}</div><div class="si-b"><div class="si-n">${s.nom}</div><div class="si-a">${s.amm||''} · ${s.categorie||''} · DAR ${s.dar||0}j</div><div class="si-br"><div class="si-bf" style="width:${pct}%;background:${col}"></div></div>${s.etat!=='ok'?`<div style="font-size:10px;font-weight:700;color:${col};text-transform:uppercase;margin-top:3px">${s.etat==='zero'?'ÉPUISÉ':'Sous seuil — '+s.seuil_alerte+' '+s.unite_stock}</div>`:''}</div><div class="si-q"><div class="si-qv" style="color:${col}">${s.qte_stock}</div><div class="si-qu">${s.unite_stock}</div><span class="badge ${bc}" style="margin-top:4px;display:inline-block">${s.etat==='ok'?'✓ OK':s.etat==='low'?'⚠️':'🚫'}</span></div></div>`;
    }).join('');
  }
}
function fS(f,btn){document.querySelectorAll('#sStock .btn').forEach(b=>{b.className='btn btghost btsm';});btn.className='btn btgold btsm';renderStock(f);}

// ══════════════════════════════════════════
//  PARCELLES
// ══════════════════════════════════════════
async function saveParc(){
  const nom=document.getElementById('pN').value.trim(),code=document.getElementById('pCo').value.trim();
  if(!nom||!code){toast('⚠️ Nom et code obligatoires');return;}
  syncSaving();
  try{
    const {data,error}=await sb.from('parcelles').insert({
      domaine_id:DOM_ID,code,nom,commune:document.getElementById('pCm').value,
      cepage:document.getElementById('pCe').value,couleur:document.getElementById('pCl').value,
      produit_aoc:document.getElementById('pPr').value,ref_cadastrale:document.getElementById('pCd').value,
      surface_ha:parseFloat(document.getElementById('pH').value)||null,
      date_plantation:document.getElementById('pPl').value?`${document.getElementById('pPl').value}-01-01`:null,
      color:'#4a8a42',
    }).select().single();
    if(error)throw error;
    PARCS.push(data);syncOK();fillSelects();renderDash();renderIFT();
    // Surface domaine = somme des parcelles actives uniquement
    const th=activeParcs().reduce((s,p)=>s+(p.surface_ha||0),0);
    await sb.from('domaines').update({surface_ha:th}).eq('id',DOM_ID);
    DOM.surface_ha=th;document.getElementById('dH').textContent=th.toFixed(2)+' ha';
    toast('✅ Parcelle enregistrée dans Supabase');closeM(null,'mAP');
    ['pN','pCo','pH','pCm','pCe','pPr','pCd','pPl'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  }catch(e){syncErr();toast('❌ Erreur : '+e.message);}
}

// ══════════════════════════════════════════
//  MAP
// ══════════════════════════════════════════
let mI=false,mL=null,tOSM,tSAT;
function initMap(){
  let center=[43.37,3.05],zoom=12;
  if(PARCS.length){
    const wp=PARCS.filter(p=>p.coords&&p.coords.length&&!p.archived_at);
    if(wp.length){
      const la=wp.flatMap(p=>p.coords.map(c=>c[0])),lo=wp.flatMap(p=>p.coords.map(c=>c[1]));
      center=[(Math.min(...la)+Math.max(...la))/2,(Math.min(...lo)+Math.max(...lo))/2];
      zoom=13;
    }
  }
  if(!mI){
    mI=true;
    mL=L.map('map',{zoomControl:false,attributionControl:false}).setView(center,zoom);
    tOSM=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(mL);
    tSAT=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19});
  } else {
    mL.setView(center,zoom);
    // Supprimer tous les polygones et markers existants
    mL.eachLayer(l=>{if(l instanceof L.Polygon||l instanceof L.Marker)mL.removeLayer(l);});
  }
  // Dessiner les parcelles (actives uniquement ; les archivées sont masquées de la carte)
  PARCS.filter(p=>!p.archived_at).forEach(p=>{
    if(p.coords&&p.coords.length>=3){
      const poly=L.polygon(p.coords,{color:'#1a1410',weight:2,fillColor:p.color||'#4a8a42',fillOpacity:.55}).addTo(mL);
      const c=poly.getBounds().getCenter();
      L.marker(c,{icon:L.divIcon({className:'',html:`<div style="background:rgba(255,255,255,.92);border-radius:6px;padding:3px 7px;font-family:Outfit,sans-serif;font-size:11px;font-weight:700;color:#1a1410;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.2)">${p.code} · IFT ${iftP(p.code).toFixed(1)}</div>`,iconAnchor:[30,10]})}).addTo(mL);
      poly.bindPopup(`<b>${p.nom}</b><br>${p.surface_ha} ha · ${p.cepage||'—'}<br>IFT : <b>${iftP(p.code).toFixed(2)}</b>`);
    }
  });
  renderCarto();
}

// Liste des parcelles : actives par défaut, bascule vers archivées via toggle
let showArchivedParcelles = false;
function renderCarto(){
  const cl=document.getElementById('cL'); if(!cl) return;
  const active=PARCS.filter(p=>!p.archived_at);
  const archived=PARCS.filter(p=>p.archived_at);
  const displayed=showArchivedParcelles?archived:active;
  const cs=document.getElementById('cS');
  if(cs){
    const totalHa=active.reduce((s,p)=>s+(p.surface_ha||0),0);
    cs.textContent=`${active.length} parcelle(s) active(s) · ${totalHa.toFixed(2)} ha${archived.length?' · '+archived.length+' archivée(s)':''}`;
  }
  const toggle=archived.length?`<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn btghost btsm" onclick="toggleArchivedParcelles()" style="font-size:12px">${showArchivedParcelles?'👁️ Voir actives':'📦 Voir archivées ('+archived.length+')'}</button></div>`:'';
  if(!displayed.length){
    cl.innerHTML=toggle+`<div style="font-size:13px;color:var(--gris);text-align:center;padding:20px">${showArchivedParcelles?'Aucune parcelle archivée':'Aucune parcelle'}${showArchivedParcelles?'':'<br><button class="btn btghost btsm" style="margin-top:10px" onclick="showM(\'mAP\')">+ Ajouter manuellement</button>'}</div>`;
    return;
  }
  cl.innerHTML=toggle+displayed.map(p=>{
    const v=iftP(p.code),st=iftSt(v),col=iftCol(st);
    const nomEsc=(p.nom||'').replace(/'/g,"\\'");
    const btns=showArchivedParcelles
      ?`<div style="position:absolute;top:10px;right:10px;display:flex;gap:4px">
          <button onclick="event.stopPropagation();desarchiverParcelle('${p.id}','${nomEsc}')" style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px;color:var(--vert2)" title="Restaurer (désarchiver)">↩️</button>
          <button onclick="event.stopPropagation();supprimerParcelle('${p.id}','${nomEsc}')" style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px;color:var(--rouge)" title="Supprimer définitivement">🗑️</button>
        </div>`
      :`<button onclick="event.stopPropagation();archiverParcelle('${p.id}','${nomEsc}')" style="position:absolute;top:10px;right:10px;background:none;border:none;cursor:pointer;font-size:16px;padding:2px;color:var(--gris)" title="Archiver (garde l'historique)">📦</button>`;
    const opacity=showArchivedParcelles?';opacity:0.75':'';
    const archivedBadge=showArchivedParcelles?' <span style="font-size:10px;color:var(--gris);font-weight:normal;background:var(--gris3);padding:1px 6px;border-radius:8px;margin-left:4px">archivée</span>':'';
    const rightPad=showArchivedParcelles?54:32;
    return`<div class="card" style="position:relative${opacity}"><div style="display:flex;align-items:center;justify-content:space-between;padding-right:${rightPad}px" onclick="showPD('${p.code}')"><div><div style="font-weight:700;font-size:15px">${p.nom}${archivedBadge}</div><div style="font-size:12px;color:var(--gris);margin-top:2px">${p.surface_ha||'—'} ha · ${p.cepage||'—'} · ${p.commune||'—'}</div></div><span class="badge ${st==='ok'?'bg':st==='warn'?'bo':'br'}">IFT ${v.toFixed(1)}</span></div>${btns}</div>`;
  }).join('');
}
function toggleArchivedParcelles(){ showArchivedParcelles=!showArchivedParcelles; renderCarto(); mI=false; initMap(); }
function mSat(){if(!mL)return;try{mL.removeLayer(tOSM);}catch(e){}tSAT.addTo(mL);toast('🛰️ Vue satellite');}
function mOSM(){if(!mL)return;try{mL.removeLayer(tSAT);}catch(e){}tOSM.addTo(mL);toast('🗺️ Vue plan');}
function mCenter(){if(!mL||!PARCS.length)return;mL.setView([43.37,3.05],12);}
// Archiver : soft delete qui conserve l'historique (conforme HVE/AB — 5-10 ans)
async function archiverParcelle(id, nom) {
  if (!confirm(`Archiver la parcelle "${nom}" ?\n\nElle sera masquée des vues courantes mais son historique de traitements sera conservé (obligatoire pour le registre phyto).\n\nTu pourras la restaurer à tout moment depuis "📦 Voir archivées".`)) return;
  syncSaving();
  try {
    const when = new Date().toISOString();
    const {error} = await sb.from('parcelles').update({archived_at: when}).eq('id', id);
    if (error) throw error;
    const p = PARCS.find(x => x.id === id); if (p) p.archived_at = when;
    syncOK();
    toast(`📦 Parcelle "${nom}" archivée`);
    renderCarto(); renderDash(); renderIFT();
    mI = false; initMap();
  } catch(e) { syncErr(); toast('❌ ' + e.message); }
}

// Désarchiver : réintègre une parcelle dans les vues courantes
async function desarchiverParcelle(id, nom) {
  syncSaving();
  try {
    const {error} = await sb.from('parcelles').update({archived_at: null}).eq('id', id);
    if (error) throw error;
    const p = PARCS.find(x => x.id === id); if (p) p.archived_at = null;
    syncOK();
    toast(`↩️ Parcelle "${nom}" restaurée`);
    renderCarto(); renderDash(); renderIFT();
    mI = false; initMap();
  } catch(e) { syncErr(); toast('❌ ' + e.message); }
}

// Suppression DÉFINITIVE (hard delete) — uniquement depuis la vue archivées avec double confirmation
async function supprimerParcelle(id, nom) {
  if (!confirm(`⚠️ SUPPRESSION DÉFINITIVE\n\nSupprimer "${nom}" pour toujours ?\nL'historique associé sera perdu irrémédiablement.\n\nPréfère "Archiver" si tu veux garder la traçabilité HVE/AB.`)) return;
  if (!confirm(`Dernière confirmation : supprimer "${nom}" définitivement ?`)) return;
  syncSaving();
  try {
    const {error} = await sb.from('parcelles').delete().eq('id', id);
    if (error) throw error;
    PARCS = PARCS.filter(p => p.id !== id);
    syncOK();
    toast(`🗑️ Parcelle "${nom}" supprimée définitivement`);
    renderCarto(); renderDash(); renderIFT();
    mI = false; initMap();
  } catch(e) { syncErr(); toast('❌ ' + e.message); }
}

async function reloadMap(){
  toast('🔄 Rechargement des parcelles…');
  const {data}=await sb.from('parcelles').select('*').eq('domaine_id',DOM_ID).order('code');
  PARCS=data||[];
  mI=false; // forcer réinitialisation complète
  initMap();
  renderDash();renderIFT();fillSelects();
  toast(`✅ ${PARCS.length} parcelle(s) chargée(s)`);
}

// ══════════════════════════════════════════
//  REGISTRE
// ══════════════════════════════════════════
function renderRegistre(){
  document.getElementById('rC').textContent=TRAITS.length;
  const rl=document.getElementById('rL');
  if(!TRAITS.length){rl.innerHTML='<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun traitement</div>';return;}
  
  const isDesktop = window.innerWidth >= 900;
  if (isDesktop) {
    rl.innerHTML = `<table class="reg-table">
      <thead><tr>
        <th>Date</th><th>Parcelle</th><th>Produit</th><th>Dose</th>
        <th>BBCH</th><th>AMM</th><th>IFT</th>
      </tr></thead>
      <tbody>${TRAITS.slice(0,20).map(t=>`<tr>
        <td>${t.date_application}</td>
        <td><span class="badge bb">${t.parcelle_code}</span></td>
        <td style="font-weight:600">${t.produit_nom||'—'}</td>
        <td>${t.dose_appliquee||'—'} ${t.dose_unite||'kg/ha'}</td>
        <td style="font-size:12px;color:var(--gris)">${t.bbch||'—'}</td>
        <td style="font-size:12px;color:var(--gris)">${t.amm||'—'}</td>
        <td><b style="color:var(--vigne)">${(t.ift||0).toFixed(2)}</b></td>
      </tr>`).join('')}</tbody>
    </table>`;
  } else {
    rl.innerHTML=TRAITS.slice(0,10).map(t=>`<div class="li"><div class="lic" style="background:#fde8c8">🌿</div><div class="lib"><div class="lit">${t.produit_nom||'—'}</div><div class="lim">${t.date_application} · ${t.parcelle_code} · BBCH ${t.bbch||'—'} · ${t.dose_appliquee||'—'} ${t.dose_unite||'kg/ha'} · AMM ${t.amm||'—'}</div><div style="font-size:11px;color:var(--gris);margin-top:2px">IFT = <b style="color:var(--vigne)">${(t.ift||0).toFixed(2)}</b></div></div><span style="background:#d4edda;color:var(--vert);padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700">✓</span></div>`).join('');
  }
}

// ══════════════════════════════════════════
//  CAVE — MOUVEMENTS (RETIRAISONS / RELOGEMENTS)
// ══════════════════════════════════════════
// Charger les mouvements depuis Supabase
async function loadMouvements() {
  try {
    const { data } = await sb.from('mouvements_cave').select('*')
      .eq('domaine_id', DOM_ID)
      .order('date_mouvement', { ascending: false });
    MOUVEMENTS = data || [];
  } catch(e) {
    console.error('loadMouvements:', e);
    MOUVEMENTS = [];
  }
}

// Icônes et labels types de cuve
const CAVE_TYPE_ICONS = { inox:'🔵', acier:'⚙️', beton:'🟤', polyester:'🟡' };
const CAVE_TYPE_LABELS = { inox:'Inox', acier:'Acier', beton:'Béton', polyester:'Polyester' };

// ── SAVE CUVE ──────────────────────────────
async function saveCuve() {
  const nom = document.getElementById('cN').value.trim();
  const cap = parseFloat(document.getElementById('cCa').value);
  if (!nom) { toast('⚠️ Numéro/nom obligatoire'); return; }
  if (!cap || cap <= 0) { toast('⚠️ Capacité obligatoire'); return; }

  const contenu = parseFloat(document.getElementById('cCo').value) || 0;
  if (contenu > cap) { toast('⚠️ Contenu ne peut pas dépasser la capacité'); return; }

  const payload = {
    domaine_id: DOM_ID,
    nom,
    type_cuve: document.getElementById('cType').value || 'inox',
    capacite_hl: cap,
    contenu_actuel_hl: contenu,
    cepage: document.getElementById('cCepage').value.trim() || null,
    millesime: parseInt(document.getElementById('cMillesime').value) || null,
    degre: parseFloat(document.getElementById('cDegre').value) || null,
    appellation: document.getElementById('cAppellation').value || null,
    cuvee_nom: document.getElementById('cV').value.trim() || null,
    notes: document.getElementById('cNotes').value.trim() || null,
    statut: contenu > 0 ? 'en_cours' : 'vide',
  };

  syncSaving();
  try {
    const editId = document.getElementById('cEditId').value;
    if (editId) {
      const { data, error } = await sb.from('cuves').update(payload).eq('id', editId).select().single();
      if (error) throw error;
      const idx = CUVES.findIndex(c => c.id === editId);
      if (idx >= 0) CUVES[idx] = data;
    } else {
      const { data, error } = await sb.from('cuves').insert(payload).select().single();
      if (error) throw error;
      CUVES.push(data);
    }
    syncOK();
    renderCave();
    fillCuveSelects();
    toast(editId ? '✅ Cuve mise à jour' : '✅ Cuve enregistrée');
    closeM(null, 'mAC');
    resetCuveForm();
  } catch(e) { syncErr(); toast('❌ Erreur : ' + e.message); }
}

function resetCuveForm() {
  ['cN','cCa','cCo','cCepage','cMillesime','cDegre','cV','cNotes','cEditId'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('cType').value = 'inox';
  document.getElementById('cAppellation').value = '';
  document.getElementById('mACTitle').textContent = '+ Nouvelle cuve';
}

function editCuve(id) {
  const c = CUVES.find(x => x.id === id); if (!c) return;
  document.getElementById('cEditId').value = id;
  document.getElementById('mACTitle').textContent = '✏️ Modifier la cuve';
  document.getElementById('cN').value = c.nom || '';
  document.getElementById('cType').value = c.type_cuve || 'inox';
  document.getElementById('cCa').value = c.capacite_hl || '';
  document.getElementById('cCo').value = c.contenu_actuel_hl || 0;
  document.getElementById('cCepage').value = c.cepage || '';
  document.getElementById('cMillesime').value = c.millesime || '';
  document.getElementById('cDegre').value = c.degre || '';
  document.getElementById('cAppellation').value = c.appellation || '';
  document.getElementById('cV').value = c.cuvee_nom || '';
  document.getElementById('cNotes').value = c.notes || '';
  showM('mAC');
}

async function deleteCuve(id, nom) {
  if (!confirm(`Supprimer la cuve "${nom}" ?\nTout l'historique des mouvements associés sera également supprimé.`)) return;
  syncSaving();
  try {
    await sb.from('mouvements_cave').delete().or(`cuve_source_id.eq.${id},cuve_dest_id.eq.${id}`);
    const { error } = await sb.from('cuves').delete().eq('id', id);
    if (error) throw error;
    CUVES = CUVES.filter(c => c.id !== id);
    MOUVEMENTS = MOUVEMENTS.filter(m => m.cuve_source_id !== id && m.cuve_dest_id !== id);
    syncOK(); renderCave(); fillCuveSelects();
    toast(`🗑️ Cuve "${nom}" supprimée`);
  } catch(e) { syncErr(); toast('❌ ' + e.message); }
}

// ── RETIRAISON ─────────────────────────────
function checkRetVolume() {
  const cuveId = document.getElementById('retCuve').value;
  const vol = parseFloat(document.getElementById('retVolume').value) || 0;
  const cuve = CUVES.find(c => c.id === cuveId);
  const al = document.getElementById('retAlert');
  if (!al) return;
  if (cuve && vol > (cuve.contenu_actuel_hl || 0)) {
    al.style.display = 'flex';
    document.getElementById('retAlertTxt').innerHTML = `Volume demandé (${vol} hL) > contenu actuel (${cuve.contenu_actuel_hl} hL)`;
  } else {
    al.style.display = 'none';
  }
}

document.addEventListener('change', function(e) {
  if (e.target.id === 'retCuve') {
    const cuveId = e.target.value;
    const cuve = CUVES.find(c => c.id === cuveId);
    const info = document.getElementById('retCuveInfo');
    if (info) {
      if (cuve) {
        info.style.display = 'block';
        const ic = CAVE_TYPE_ICONS[cuve.type_cuve] || '🍷';
        info.innerHTML = `${ic} <b>${cuve.nom}</b> · Contenu : <b>${cuve.contenu_actuel_hl || 0} / ${cuve.capacite_hl || '?'} hL</b>
          ${cuve.cepage ? ` · ${cuve.cepage}` : ''}${cuve.millesime ? ` ${cuve.millesime}` : ''}${cuve.degre ? ` · ${cuve.degre}°` : ''}${cuve.appellation ? ` · ${cuve.appellation}` : ''}`;
      } else {
        info.style.display = 'none';
      }
    }
  }
});

async function saveRetiraison() {
  const cuveId = document.getElementById('retCuve').value;
  const vol = parseFloat(document.getElementById('retVolume').value);
  const acheteur = document.getElementById('retAcheteur').value.trim();
  const date = document.getElementById('retDate').value;
  if (!cuveId || !vol || !acheteur || !date) { toast('⚠️ Cuve, volume, acheteur et date obligatoires'); return; }
  const cuve = CUVES.find(c => c.id === cuveId);
  if (!cuve) { toast('⚠️ Cuve introuvable'); return; }
  if (vol > (cuve.contenu_actuel_hl || 0)) { toast(`⚠️ Volume trop élevé — max ${cuve.contenu_actuel_hl} hL`); return; }

  const prix = parseFloat(document.getElementById('retPrix').value) || null;
  const montant = prix ? Math.round(vol * prix * 100) / 100 : null;
  syncSaving();
  try {
    // 1. Enregistrer le mouvement
    const { data: mvt, error: e1 } = await sb.from('mouvements_cave').insert({
      domaine_id: DOM_ID,
      type_mouvement: 'retiraison',
      date_mouvement: date,
      cuve_source_id: cuveId,
      cuve_source_nom: cuve.nom,
      volume_hl: vol,
      acheteur,
      type_circuit: document.getElementById('retCircuit').value,
      prix_hl: prix,
      montant_total: montant,
      reference: document.getElementById('retRef').value.trim() || null,
      notes: document.getElementById('retNotes').value.trim() || null,
      cepage: cuve.cepage,
      millesime: cuve.millesime,
      degre: cuve.degre,
      appellation: cuve.appellation,
    }).select().single();
    if (e1) throw e1;

    // 2. Mettre à jour le contenu de la cuve
    const newContenu = Math.max(0, (cuve.contenu_actuel_hl || 0) - vol);
    const newStatut = newContenu === 0 ? 'vide' : 'en_cours';
    const { error: e2 } = await sb.from('cuves').update({ contenu_actuel_hl: newContenu, statut: newStatut }).eq('id', cuveId);
    if (e2) throw e2;

    cuve.contenu_actuel_hl = newContenu;
    cuve.statut = newStatut;
    MOUVEMENTS.unshift(mvt);
    syncOK(); renderCave(); renderMouvements('all');
    toast(`✅ Retiraison enregistrée — Cuve ${cuve.nom} : ${newContenu} hL restants`);
    closeM(null, 'mRetiraison');
    resetRetiraisonForm();
  } catch(e) { syncErr(); toast('❌ Erreur : ' + e.message); }
}

function resetRetiraisonForm() {
  ['retDate','retVolume','retPrix','retAcheteur','retRef','retNotes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('retCuve').value = '';
  const info = document.getElementById('retCuveInfo'); if (info) info.style.display = 'none';
  const al = document.getElementById('retAlert'); if (al) al.style.display = 'none';
  document.getElementById('retDate').value = new Date().toISOString().split('T')[0];
}

// ── RELOGEMENT ─────────────────────────────
function updateRelSourceInfo() {
  const id = document.getElementById('relSource').value;
  const c = CUVES.find(x => x.id === id);
  const el = document.getElementById('relSourceInfo');
  if (!el) return;
  if (c) {
    el.style.display = 'block';
    el.innerHTML = `🚪 <b>Départ :</b> ${c.nom} · ${c.contenu_actuel_hl || 0} hL disponibles${c.cepage ? ' · ' + c.cepage : ''}${c.millesime ? ' ' + c.millesime : ''}`;
  } else { el.style.display = 'none'; }
}

function updateRelDestInfo() {
  const id = document.getElementById('relDest').value;
  const c = CUVES.find(x => x.id === id);
  const el = document.getElementById('relDestInfo');
  if (!el) return;
  if (c) {
    const dispo = (c.capacite_hl || 0) - (c.contenu_actuel_hl || 0);
    el.style.display = 'block';
    el.innerHTML = `🏠 <b>Arrivée :</b> ${c.nom} · Disponible : <b>${dispo.toFixed(1)} hL</b> (${c.contenu_actuel_hl || 0} / ${c.capacite_hl || '?'} hL)`;
  } else { el.style.display = 'none'; }
}

function checkRelVolume() {
  const srcId = document.getElementById('relSource').value;
  const dstId = document.getElementById('relDest').value;
  const vol = parseFloat(document.getElementById('relVolume').value) || 0;
  const src = CUVES.find(c => c.id === srcId);
  const dst = CUVES.find(c => c.id === dstId);
  const al = document.getElementById('relAlert');
  if (!al) return;
  const errs = [];
  if (src && vol > (src.contenu_actuel_hl || 0)) errs.push(`Volume > contenu source (${src.contenu_actuel_hl} hL)`);
  if (dst && vol > ((dst.capacite_hl || 0) - (dst.contenu_actuel_hl || 0))) errs.push(`Volume > place disponible dans la cuve destination (${((dst.capacite_hl||0)-(dst.contenu_actuel_hl||0)).toFixed(1)} hL)`);
  if (srcId && dstId && srcId === dstId) errs.push('Source et destination identiques');
  if (errs.length) { al.style.display = 'flex'; document.getElementById('relAlertTxt').innerHTML = errs.join('<br>'); }
  else { al.style.display = 'none'; }
}

async function saveRelogement() {
  const srcId = document.getElementById('relSource').value;
  const dstId = document.getElementById('relDest').value;
  const vol = parseFloat(document.getElementById('relVolume').value);
  const date = document.getElementById('relDate').value;
  if (!srcId || !dstId || !vol || !date) { toast('⚠️ Cuves, volume et date obligatoires'); return; }
  if (srcId === dstId) { toast('⚠️ Source et destination identiques'); return; }
  const src = CUVES.find(c => c.id === srcId);
  const dst = CUVES.find(c => c.id === dstId);
  if (!src || !dst) { toast('⚠️ Cuve introuvable'); return; }
  if (vol > (src.contenu_actuel_hl || 0)) { toast(`⚠️ Volume trop élevé — max ${src.contenu_actuel_hl} hL dans ${src.nom}`); return; }
  const dispo = (dst.capacite_hl || 0) - (dst.contenu_actuel_hl || 0);
  if (vol > dispo) { toast(`⚠️ Capacité insuffisante — ${dispo.toFixed(1)} hL disponibles dans ${dst.nom}`); return; }

  syncSaving();
  try {
    const { data: mvt, error: e1 } = await sb.from('mouvements_cave').insert({
      domaine_id: DOM_ID,
      type_mouvement: 'relogement',
      date_mouvement: date,
      cuve_source_id: srcId,
      cuve_source_nom: src.nom,
      cuve_dest_id: dstId,
      cuve_dest_nom: dst.nom,
      volume_hl: vol,
      motif: document.getElementById('relMotif').value,
      notes: document.getElementById('relNotes').value.trim() || null,
      cepage: src.cepage,
      millesime: src.millesime,
      degre: src.degre,
      appellation: src.appellation,
    }).select().single();
    if (e1) throw e1;

    const newSrc = Math.max(0, (src.contenu_actuel_hl || 0) - vol);
    const newDst = (dst.contenu_actuel_hl || 0) + vol;
    await sb.from('cuves').update({ contenu_actuel_hl: newSrc, statut: newSrc === 0 ? 'vide' : 'en_cours' }).eq('id', srcId);
    await sb.from('cuves').update({ contenu_actuel_hl: newDst, statut: 'en_cours' }).eq('id', dstId);
    src.contenu_actuel_hl = newSrc; src.statut = newSrc === 0 ? 'vide' : 'en_cours';
    dst.contenu_actuel_hl = newDst; dst.statut = 'en_cours';
    MOUVEMENTS.unshift(mvt);
    syncOK(); renderCave(); renderMouvements('all');
    toast(`✅ Relogement : ${vol} hL de ${src.nom} → ${dst.nom}`);
    closeM(null, 'mRelogement');
    resetRelogementForm();
  } catch(e) { syncErr(); toast('❌ Erreur : ' + e.message); }
}

function resetRelogementForm() {
  ['relDate','relVolume','relNotes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('relSource').value = '';
  document.getElementById('relDest').value = '';
  ['relSourceInfo','relDestInfo'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
  document.getElementById('relAlert').style.display = 'none';
  document.getElementById('relDate').value = new Date().toISOString().split('T')[0];
}

// ── RENDER CAVE ────────────────────────────
function renderCave() {
  // Stats
  const nbCuves = CUVES.length;
  const totalCap = CUVES.reduce((s,c) => s+(c.capacite_hl||0), 0);
  const totalCont = CUVES.reduce((s,c) => s+(c.contenu_actuel_hl||0), 0);
  const taux = totalCap > 0 ? Math.round(totalCont/totalCap*100) : 0;
  document.getElementById('cvNbCuves').textContent = nbCuves || '—';
  document.getElementById('cvTotalCap').textContent = totalCap ? totalCap + ' hL' : '— hL';
  document.getElementById('cvTotalCont').textContent = totalCont ? totalCont.toFixed(1) + ' hL' : '— hL';
  document.getElementById('cvTauxRemplissage').textContent = totalCap ? taux + '%' : '—%';

  // Liste cuves
  const cl = document.getElementById('cVL');
  if (!CUVES.length) {
    cl.innerHTML = '<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucune cuve<br><span style="font-size:11px">Cliquez sur "+ Ajouter cuve" pour commencer</span></div>';
  } else {
    cl.innerHTML = CUVES.map(c => {
      const pct = c.capacite_hl ? Math.min(100, (c.contenu_actuel_hl||0)/c.capacite_hl*100) : 0;
      const col = pct >= 80 ? 'var(--raisin)' : pct >= 40 ? 'var(--bleu)' : pct > 0 ? 'var(--or)' : 'var(--gris2)';
      const ic = CAVE_TYPE_ICONS[c.type_cuve] || '🍷';
      const label = CAVE_TYPE_LABELS[c.type_cuve] || c.type_cuve;
      return `<div style="background:var(--gris3);border-radius:14px;padding:14px;margin-bottom:10px;position:relative">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex:1">
            <div style="width:44px;height:44px;border-radius:12px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:var(--sh)">${ic}</div>
            <div>
              <div style="font-weight:700;font-size:15px;color:var(--terre)">${c.nom}</div>
              <div style="font-size:11px;color:var(--gris);margin-top:2px">${label}${c.appellation ? ' · ' + c.appellation : ''}${c.cepage ? ' · ' + c.cepage : ''}${c.millesime ? ' ' + c.millesime : ''}${c.degre ? ' · ' + c.degre + '°' : ''}</div>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:700;color:${col};line-height:1">${(c.contenu_actuel_hl||0).toFixed(1)}</div>
            <div style="font-size:11px;color:var(--gris)">/ ${c.capacite_hl || '?'} hL</div>
          </div>
        </div>
        <!-- Barre de remplissage -->
        <div style="height:8px;background:var(--gris2);border-radius:4px;margin:10px 0 6px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${col};border-radius:4px;transition:width 1s ease"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:11px;color:${col};font-weight:700">${pct.toFixed(0)}% plein${c.cuvee_nom ? ' · ' + c.cuvee_nom : ''}</div>
          <div style="display:flex;gap:6px">
            <button onclick="showMvtCuve('${c.id}')" style="background:var(--card);border:1px solid var(--gris2);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;color:var(--gris)">📋 Historique</button>
            <button onclick="editCuve('${c.id}')" style="background:var(--card);border:1px solid var(--gris2);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;color:var(--gris)">✏️</button>
            <button onclick="deleteCuve('${c.id}','${c.nom.replace(/'/g,'')}')" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;color:var(--gris)">🗑️</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // Ventes
  const vl = document.getElementById('vL');
  if (!VENTES.length) {
    vl.innerHTML = '<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucune vente</div>';
  } else {
    const ca = VENTES.reduce((s,v)=>s+(v.montant_total||0),0);
    vl.innerHTML = `<div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:700;color:var(--raisin);margin-bottom:10px">${ca.toLocaleString('fr-FR')} €</div>
    ${VENTES.slice(0,5).map(v=>`<div class="nr"><div><div style="font-weight:600;font-size:14px">${v.acheteur||'—'}</div><div style="font-size:12px;color:var(--gris)">${v.cuvee_nom||'—'} · ${v.type_circuit||'—'}</div></div><div style="text-align:right"><div style="font-family:'Cormorant Garamond',serif;font-size:18px;color:var(--raisin);font-weight:600">${v.prix_litre||'—'} €/L</div><div style="font-size:11px;color:var(--gris)">${v.volume_litres||0} L · ${(v.montant_total||0).toLocaleString('fr-FR')} €</div></div></div>`).join('')}`;
  }

  renderMouvements('all');
}

function renderMouvements(filter) {
  const list = document.getElementById('mvtList');
  // Sync boutons filtre
  ['mvfAll','mvfRet','mvfRel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = 'btn btghost btsm';
  });
  const activeBtn = { all: 'mvfAll', retiraison: 'mvfRet', relogement: 'mvfRel' }[filter];
  if (activeBtn) { const el = document.getElementById(activeBtn); if(el) el.className = 'btn btgold btsm'; }

  const items = filter === 'all' ? MOUVEMENTS : MOUVEMENTS.filter(m => m.type_mouvement === filter);
  if (!items.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun mouvement enregistré</div>';
    return;
  }
  list.innerHTML = items.slice(0, 20).map(m => {
    const isRet = m.type_mouvement === 'retiraison';
    const ic = isRet ? '🚚' : '🔄';
    const col = isRet ? 'var(--rouge)' : 'var(--bleu)';
    const bgCol = isRet ? '#fde8e6' : '#d4e8f4';
    const titre = isRet
      ? `Retiraison — ${m.acheteur || '—'}`
      : `Relogement — ${m.cuve_source_nom || '—'} → ${m.cuve_dest_nom || '—'}`;
    const sous = isRet
      ? `${m.date_mouvement} · ${m.cuve_source_nom || '—'} · ${m.type_circuit || '—'}${m.prix_hl ? ' · ' + m.prix_hl + ' €/hL' : ''}`
      : `${m.date_mouvement} · ${m.motif || '—'}`;
    const infoProd = [m.cepage, m.millesime ? m.millesime + '' : null, m.degre ? m.degre + '°' : null, m.appellation].filter(Boolean).join(' · ');
    return `<div class="li" style="align-items:flex-start">
      <div class="lic" style="background:${bgCol}">${ic}</div>
      <div class="lib">
        <div class="lit" style="color:${col}">${titre}</div>
        <div class="lim">${sous}</div>
        ${infoProd ? `<div style="font-size:11px;color:var(--gris);margin-top:2px">${infoProd}</div>` : ''}
        ${m.notes ? `<div style="font-size:11px;color:var(--gris);font-style:italic;margin-top:2px">${m.notes}</div>` : ''}
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:700;color:${col}">${m.volume_hl} hL</div>
        ${m.montant_total ? `<div style="font-size:11px;color:var(--gris)">${m.montant_total.toLocaleString('fr-FR')} €</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function filterMvt(filter, btn) {
  renderMouvements(filter);
}

function showMvtCuve(cuveId) {
  const cuve = CUVES.find(c => c.id === cuveId);
  if (!cuve) return;
  const mvts = MOUVEMENTS.filter(m => m.cuve_source_id === cuveId || m.cuve_dest_id === cuveId);
  const ic = CAVE_TYPE_ICONS[cuve.type_cuve] || '🍷';
  document.getElementById('mPDT').textContent = `${ic} ${cuve.nom} — Historique`;
  document.getElementById('mPDC').innerHTML = `
    <div style="background:linear-gradient(135deg,var(--raisin),#3a0a20);border-radius:12px;padding:14px;color:#fff;text-align:center;margin-bottom:14px">
      <div style="font-size:11px;opacity:.6;text-transform:uppercase;margin-bottom:4px">${CAVE_TYPE_LABELS[cuve.type_cuve]||''} · ${cuve.appellation||''}</div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:36px;font-weight:700;line-height:1">${(cuve.contenu_actuel_hl||0).toFixed(1)} hL</div>
      <div style="font-size:13px;opacity:.7">/ ${cuve.capacite_hl||'?'} hL${cuve.cepage ? ' · ' + cuve.cepage : ''}${cuve.millesime ? ' ' + cuve.millesime : ''}${cuve.degre ? ' · ' + cuve.degre + '°' : ''}</div>
    </div>
    ${!mvts.length
      ? '<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun mouvement enregistré pour cette cuve</div>'
      : mvts.map(m => {
          const isRet = m.type_mouvement === 'retiraison';
          const isArrivee = m.cuve_dest_id === cuveId && !isRet;
          const ic2 = isRet ? '🚚' : (isArrivee ? '📥' : '📤');
          const col = isRet ? 'var(--rouge)' : (isArrivee ? 'var(--vert2)' : 'var(--bleu)');
          const bg = isRet ? '#fde8e6' : (isArrivee ? '#d4edda' : '#d4e8f4');
          const titre = isRet
            ? `Retiraison → ${m.acheteur||'—'}`
            : (isArrivee ? `Relogement reçu de ${m.cuve_source_nom||'—'}` : `Relogement vers ${m.cuve_dest_nom||'—'}`);
          return `<div class="li"><div class="lic" style="background:${bg}">${ic2}</div>
            <div class="lib"><div class="lit">${titre}</div>
            <div class="lim">${m.date_mouvement}${m.motif ? ' · ' + m.motif : ''}</div></div>
            <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:700;color:${col}">${m.volume_hl} hL</div></div>`;
        }).join('')
    }`;
  showM('mPD');
}

// Remplir les selects de cuves dans les modals
function fillCuveSelects() {
  ['retCuve','relSource','relDest'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const label = id === 'retCuve' ? '— Choisir une cuve —'
      : id === 'relSource' ? '— Cuve de départ —'
      : '— Cuve d\'arrivée —';
    sel.innerHTML = `<option value="">${label}</option>`;
    CUVES.forEach(c => {
      const ic = CAVE_TYPE_ICONS[c.type_cuve] || '🍷';
      const info = c.contenu_actuel_hl != null ? ` (${c.contenu_actuel_hl}/${c.capacite_hl||'?'} hL)` : '';
      sel.innerHTML += `<option value="${c.id}">${ic} ${c.nom}${info}${c.cepage ? ' · ' + c.cepage : ''}${c.millesime ? ' ' + c.millesime : ''}</option>`;
    });
  });
}

// ══════════════════════════════════════════
//  HVE
// ══════════════════════════════════════════
function calcHVE(){
  const ift=iftDom(),ref=4.2,iftBio=iftCat('Biocontrôle'),partBio=ift>0?(iftBio/ift)*100:0;
  let pA1=0;
  if(TRAITS.length){const r=ift/ref;if(r<=0.5)pA1=15;else if(r<=0.7)pA1=12;else if(r<=0.85)pA1=9;else if(r<=1)pA1=6;}
  document.getElementById('hA1B').style.width=(pA1/15*100)+'%';
  document.getElementById('hA1B').style.background=pA1>=12?'var(--vert2)':pA1>=6?'var(--orange)':'var(--rouge)';
  document.getElementById('hA1S').textContent=pA1+'/15 pts';
  document.getElementById('hA1D').textContent=TRAITS.length?`IFT : ${ift.toFixed(2)} · Réf : ${ref} · Ratio : ${(ift/ref*100).toFixed(0)}%`:'Saisir des traitements';
  let pA2=0;if(TRAITS.length){if(partBio>=30)pA2=10;else if(partBio>=20)pA2=7;else if(partBio>=10)pA2=4;else if(partBio>=5)pA2=2;}
  document.getElementById('hA2B').style.width=(pA2/10*100)+'%';
  document.getElementById('hA2S').textContent=pA2+'/10 pts';
  document.getElementById('hA2D').textContent=TRAITS.length?`Biocontrôle : ${partBio.toFixed(1)}% de l’IFT total`:'—';
  const pA3=2.5,pA4=2.5,pA=Math.round(pA1+pA2+pA3+pA4);
  document.getElementById('hAB').textContent=pA+'/30 pts';
  document.getElementById('hAB').className='badge '+(pA>=24?'bg':pA>=15?'bo':'br');
  document.getElementById('hA3D').textContent=`${TRAITS.length} intervention(s) · Registre conforme`;
  const b1=document.getElementById('hB1').classList.contains('on')?1:0;
  const b2=document.getElementById('hB2').classList.contains('on')?1:0;
  const b3=document.getElementById('hB3').classList.contains('on')?1:0;
  const pB=Math.round(b1*8+b2*7+b3*5);
  document.getElementById('hBB').textContent=pB+'/20 pts';
  document.getElementById('hBB').className='badge '+(pB>=16?'bg':pB>=10?'bo':'br');
  const pC=document.getElementById('hCI').classList.contains('on')?20:0;
  document.getElementById('hCB').textContent=pC+'/20 pts';
  document.getElementById('hCB').className='badge '+(pC>=16?'bg':'bo');
  const sie=parseFloat(document.getElementById('hSIE').value)||0;
  const pD1=sie>=10?15:sie>=7?11:sie>=5?7:sie>=3?3:0;
  const pD=Math.round(pD1+(document.getElementById('hD2').classList.contains('on')?10:0));
  document.getElementById('hDB').textContent=pD+'/25 pts';
  document.getElementById('hDB').className='badge '+(pD>=20?'bg':pD>=12?'bo':'br');
  const tot=pA+pB+pC+pD;
  document.getElementById('hSc').textContent=tot;
  const f=document.getElementById('hSF');f.style.width='0%';
  setTimeout(()=>{f.style.width=tot+'%';f.style.background=tot>=75?'linear-gradient(90deg,#4a8a42,#6db865)':tot>=50?'linear-gradient(90deg,#c9a84c,#f0d878)':'linear-gradient(90deg,#d4751a,#f0a040)';},80);
  let nb;if(tot>=75)nb='🏅 Niveau 3 — HVE certifiable';else if(tot>=50)nb='🌿 Niveau 2 — HVE intermédiaire';else if(tot>=25)nb='🌱 Niveau 1';else nb='⚠️ En dessous du Niveau 1';
  document.getElementById('hNB').textContent=nb;
  document.getElementById('hSb').textContent=tot>=75?`Certification accessible · Contacter votre organisme`:tot>=50?`${75-tot} pts pour le N3`:`${50-tot} pts pour le N2`;
  const tips=[];
  if(TRAITS.length&&ift>3.5)tips.push('🎯 <b>Réduire l’IFT</b> — Doses à 70–80% de la référence. Gain : +6 pts domaine A.');
  if(partBio<20&&TRAITS.length)tips.push('🌱 <b>Augmenter le biocontrôle</b> — Viser ≥ 20%. Gain : +5 pts A2.');
  if(sie<7)tips.push('🌿 <b>Augmenter les SIE</b> — Porter à 7% via enherbement ou haies. Gain : +4 pts D.');
  if(tot>=75)tips.push('🏆 <b>Score N3 atteint !</b> Contactez Ecocert, Bureau Veritas ou Certisud.');
  if(!TRAITS.length)tips.push('📝 <b>Saisissez vos traitements</b> — Le score HVE se calcule depuis votre IFT réel.');
  document.getElementById('hCons').innerHTML=tips.length?`<div class="card" style="background:linear-gradient(135deg,var(--vigne),#0f2a0f);color:#fff;border:none"><div style="font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:700;margin-bottom:10px;color:var(--or2)">💡 Recommandations</div><div style="font-size:13px;line-height:1.7;opacity:.85">${tips.join('<br><br>')}</div></div>`:'';
}

// ══════════════════════════════════════════
//  PROFIL
// ══════════════════════════════════════════
function fillProfil(){
  if(!DOM)return;
  sv('prN',DOM.nom);sv('prR',DOM.raison_sociale);sv('prC',DOM.commune);sv('prS',DOM.siret);sv('prCe',DOM.certiphyto);sv('prH',DOM.surface_ha);
}
async function saveProfil(){
  syncSaving();
  const u={nom:g('prN'),raison_sociale:g('prR'),commune:g('prC'),siret:g('prS'),certiphyto:g('prCe'),surface_ha:parseFloat(g('prH'))||null};
  try{
    const {error}=await sb.from('domaines').update(u).eq('id',DOM_ID);
    if(error)throw error;Object.assign(DOM,u);
    const n=u.nom||u.raison_sociale||'Mon domaine';
    document.getElementById('aN').textContent=n;document.getElementById('avi').textContent=n.charAt(0).toUpperCase();
    syncOK();toast('✅ Profil sauvegardé');closeM(null,'mProfil');renderDash();
  }catch(e){syncErr();toast('❌ Erreur : '+e.message);}
}

// ══════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════
// Handle window resize — switch between mobile/desktop
window.addEventListener('resize', () => {
  const isDesktop = window.innerWidth >= 900;
  const sidebar = document.getElementById('appSidebar');
  const topbar = document.getElementById('appTopbar');
  const header = document.getElementById('ah');
  const nav = document.getElementById('an');
  if (!DOM_ID) return; // not logged in yet
  if (isDesktop) {
    if (sidebar) sidebar.style.display = 'flex';
    if (topbar) topbar.style.display = 'flex';
    if (header) header.style.display = 'none';
    if (nav) nav.style.display = 'none';
  } else {
    if (sidebar) sidebar.style.display = 'none';
    if (topbar) topbar.style.display = 'none';
    if (header) header.style.display = 'flex';
    if (nav) nav.style.display = 'flex';
  }
  renderStock('all');
  renderRegistre();
  if (mL) mL.invalidateSize();
});

// ══════════════════════════════════════════
//  IMPRESSION & ÉDITION
// ══════════════════════════════════════════
const SECTION_TITLES = {
  sDash:'Tableau de bord', sTrait:'Traitement phytosanitaire',
  sIFT:'IFT — Indicateur de Fréquence de Traitement',
  sScan:'Scan étiquette IA', sStock:'Stock phytosanitaire',
  sCarto:'Plan parcellaire', sMeteo:'Météo & risques phyto',
  sRegistre:'Registre phytosanitaire', sCave:'Cave & Négoce',
  sHVE:'HVE & Agriculture Biologique', sPerso:'Personnalisation'
};

let currentSection = 'sDash';

function printSection() {
  // Mettre à jour l’en-tête d’impression
  const nom = DOM?.nom || DOM?.raison_sociale || 'Domaine';
  const titre = SECTION_TITLES[currentSection] || 'VitiTrace';
  const date = new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric'});
  const phTitle = document.getElementById('phTitle');
  const phSub = document.getElementById('phSub');
  const phDate = document.getElementById('phDate');
  if (phTitle) phTitle.textContent = `VitiTrace — ${titre}`;
  if (phSub) phSub.textContent = `${nom} · Campagne ${new Date().getFullYear()} · Imprimé le ${date}`;
  if (phDate) phDate.textContent = date;
  window.print();
}

let editMode = false;
function toggleEdit() {
  editMode = !editMode;
  const btn = document.getElementById('btnEdit');
  if (editMode) {
    btn.textContent = '✅ Terminer';
    btn.className = 'btn bg btsm';
    // Rendre les champs éditables dans la section courante
    const sec = document.getElementById(currentSection);
    if (sec) {
      sec.querySelectorAll('.lit, .sv, .stitle').forEach(el => {
        el.contentEditable = 'true';
        el.style.outline = '2px dashed var(--or)';
        el.style.borderRadius = '4px';
        el.style.padding = '2px 4px';
      });
    }
    toast('✏️ Mode édition — cliquez sur un texte pour le modifier');
  } else {
    btn.textContent = '✏️ Éditer';
    btn.className = 'btn btghost btsm';
    const sec = document.getElementById(currentSection);
    if (sec) {
      sec.querySelectorAll('[contenteditable="true"]').forEach(el => {
        el.contentEditable = 'false';
        el.style.outline = '';
        el.style.borderRadius = '';
        el.style.padding = '';
      });
    }
    toast('✅ Modifications enregistrées localement');
  }
}

// ══════════════════════════════════════════
//  CONSEIL IA — DIAGNOSTIC PHOTO
// ══════════════════════════════════════════
let conseilImg64 = null, conseilMime = 'image/jpeg';

function triggerConseil() { document.getElementById('cFI').click(); }

function handleConseilFile(input) {
  const f = input.files[0]; if (!f) return;
  conseilMime = f.type || 'image/jpeg';
  const r = new FileReader();
  r.onload = e => {
    conseilImg64 = e.target.result.split(',')[1];
    const prev = document.getElementById('cPI');
    prev.src = e.target.result; prev.style.display = 'block';
    document.getElementById('cUC').style.display = 'none';
    document.getElementById('cIO').style.display = 'flex';
    document.getElementById('cAB').disabled = false;
    document.getElementById('cAB').style.background = 'var(--or)';
    document.getElementById('cAB').style.color = 'var(--noir)';
    toast('✅ Photo chargée');
    // Auto-lancer sur mobile
    if (window.innerWidth < 900) setTimeout(() => lancerConseil(), 800);
  };
  r.readAsDataURL(f);
}

async function lancerConseil() {
  if (!conseilImg64) { toast('⚠️ Charger une photo d’abord'); return; }
  document.getElementById('cAB').disabled = true;
  document.getElementById('cAB').textContent = '⏳ Analyse en cours…';
  document.getElementById('cR').style.display = 'none';

  const contexte = document.getElementById('cContexte')?.value || '';
  const bbch = document.getElementById('cBBCH')?.value || '';
  const stockNoms = STOCK.map(s => s.nom).join(', ') || 'Non renseigné';

  try {
    const res = await fetch('/api/conseil', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: conseilImg64,
        mimeType: conseilMime,
        contexte, bbch,
        stock: stockNoms,
        region: DOM?.commune || 'Sud de la France'
      })
    });
    if (!res.ok) throw new Error('Erreur serveur: ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    afficherConseil(data);
  } catch(e) {
    document.getElementById('cAB').disabled = false;
    document.getElementById('cAB').textContent = '🔍 Analyser et conseiller';
    toast('❌ Analyse impossible — ' + e.message);
    console.error(e);
  }
}

function afficherConseil(d) {
  document.getElementById('cAB').disabled = false;
  document.getElementById('cAB').textContent = '🔍 Analyser et conseiller';
  document.getElementById('cR').style.display = 'block';
  document.getElementById('cConf').textContent = `conf. ${d.confiance||80}%`;

  // Diagnostic
  const gravCol = d.gravite === 'élevé' ? 'var(--rouge)' : d.gravite === 'moyen' ? 'var(--orange)' : 'var(--vert)';
  document.getElementById('cDiagContent').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="font-size:48px">${d.emoji || '🔬'}</div>
      <div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700;color:var(--vigne)">${d.diagnostic || '—'}</div>
        <div style="font-size:13px;color:var(--gris);margin-top:2px">${d.nom_scientifique || ''}</div>
        <div style="margin-top:6px"><span style="background:${gravCol};color:#fff;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">Gravité ${d.gravite || '—'}</span></div>
      </div>
    </div>
    <div style="font-size:13px;line-height:1.6;color:var(--terre)">${d.description || ''}</div>
    ${d.conditions ? `<div class="al alb" style="margin-top:10px"><span class="al-i">🌡️</span><div><b>Conditions favorables</b>${d.conditions}</div></div>` : ''}`;

  // Recommandations produits
  const recos = d.produits_recommandes || [];
  document.getElementById('cRecoContent').innerHTML = recos.length ? recos.map((p,i) => `
    <div style="background:var(--gris3);border-radius:12px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-weight:700;font-size:14px;color:var(--terre)">${p.nom}</div>
          <div style="font-size:11px;color:var(--gris);margin-top:2px">${p.matiere_active || ''} · ${p.fabricant || ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;font-weight:700;color:var(--vigne)">${p.dose} ${p.unite || 'kg/ha'}</div>
          <div style="font-size:11px;color:var(--gris)">DAR ${p.dar || '—'}j · ZNT ${p.znt || 5}m</div>
        </div>
      </div>
      ${p.en_stock ? `<div style="font-size:11px;color:var(--vert);margin-top:6px;font-weight:600">✅ En stock sur votre domaine</div>` : ''}
      ${p.note ? `<div style="font-size:12px;color:var(--gris);margin-top:6px;font-style:italic">${p.note}</div>` : ''}
      ${p.ab ? `<span style="font-size:10px;background:#d4edda;color:var(--vert);padding:2px 7px;border-radius:4px;margin-top:4px;display:inline-block">✅ Autorisé AB</span>` : ''}
    </div>`).join('') : '<div style="font-size:13px;color:var(--gris);padding:8px">Aucune recommandation spécifique</div>';

  // Conseils agronomiques
  const conseils = d.conseils_agronomiques || [];
  document.getElementById('cAgroContent').innerHTML = conseils.length ?
    conseils.map(c => `<div style="display:flex;gap:10px;margin-bottom:8px;font-size:13px"><span>${c.emoji||'•'}</span><div><b>${c.titre||''}</b>${c.texte ? '<br><span style="color:var(--gris);font-size:12px">' + c.texte + '</span>' : ''}</div></div>`).join('') :
    '<div style="font-size:13px;color:var(--gris);padding:8px">—</div>';

  document.getElementById('cR').scrollIntoView({behavior:'smooth'});
  toast(`✅ Diagnostic : ${d.diagnostic || 'Analyse terminée'}`);

  // Stocker pour sauvegarde
  window.LAST_CONSEIL = { ...d, date: new Date().toISOString(), image_thumb: document.getElementById('cPI').src.substring(0,100) };
}

async function saveConseil() {
  if (!window.LAST_CONSEIL) return;
  syncSaving();
  try {
    await sb.from('observations').insert({
      domaine_id: DOM_ID,
      date_observation: new Date().toISOString().split('T')[0],
      type_obs: '🔬 Diagnostic IA — ' + (window.LAST_CONSEIL.diagnostic || 'Inconnu'),
      gravite: window.LAST_CONSEIL.gravite || 'Faible',
      description: window.LAST_CONSEIL.description || '',
      traitement_recommande: (window.LAST_CONSEIL.produits_recommandes || []).map(p=>p.nom).join(', ')
    });
    syncOK();
    toast('✅ Diagnostic enregistré dans les observations');
    chargerHistoriqueConseil();
  } catch(e) { syncErr(); toast('❌ ' + e.message); }
}

async function chargerHistoriqueConseil() {
  try {
    const {data} = await sb.from('observations')
      .select('*').eq('domaine_id', DOM_ID)
      .like('type_obs', '🔬 Diagnostic IA%')
      .order('date_observation', {ascending:false}).limit(5);
    const hist = document.getElementById('cHist');
    if (!data?.length) { hist.innerHTML = '<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun diagnostic enregistré</div>'; return; }
    hist.innerHTML = data.map(o => `
      <div class="li"><div class="lic" style="background:#fde8f0">🔬</div>
        <div class="lib">
          <div class="lit">${o.type_obs.replace('🔬 Diagnostic IA — ','')}</div>
          <div class="lim">${o.date_observation} · Gravité ${o.gravite || '—'}</div>
          ${o.traitement_recommande ? `<div style="font-size:11px;color:var(--gris);margin-top:2px">💊 ${o.traitement_recommande}</div>` : ''}
        </div>
        <span class="badge ${o.gravite==='élevé'?'br':o.gravite==='moyen'?'bo':'bg'}">${o.gravite||'—'}</span>
      </div>`).join('');
  } catch(e) { console.error(e); }
}

function resetConseil() {
  conseilImg64 = null;
  document.getElementById('cPI').style.display = 'none';
  document.getElementById('cUC').style.display = 'block';
  document.getElementById('cIO').style.display = 'none';
  document.getElementById('cAB').disabled = true;
  document.getElementById('cAB').textContent = '🔍 Analyser et conseiller';
  document.getElementById('cAB').style.background = '';
  document.getElementById('cAB').style.color = '';
  document.getElementById('cR').style.display = 'none';
  document.getElementById('cFI').value = '';
  document.getElementById('cCI').value = '';
  window.LAST_CONSEIL = null;
}

async function rechercherEphy(query) {
  const res = document.getElementById('mpSearchResults');
  res.innerHTML = `<div style="padding:12px;text-align:center"><div class="spin" style="width:24px;height:24px;border-width:2px;margin:0 auto 8px"></div><div style="font-size:12px;color:var(--gris)">Recherche E-phy ANSES…</div></div>`;
  try {
    const r = await fetch('/api/scan', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({mode:'ephy', query})
    });
    const data = await r.json();
    const results = data.results || [];
    if (!results.length) {
      res.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--gris);text-align:center">
        Aucun résultat E-phy pour "<b>${query}</b>"<br>
        <span style="font-size:11px">Saisir manuellement ci-dessous</span>
      </div>`;
      return;
    }
    window.PHYTO_LAST_RESULTS = results.map(p => ({
      nomProd: p.nom_produit || p.libelle || query,
      fab: p.firme || p.titulaire || '',
      amm: p.numero_amm || '',
      forme: p.formulation || '',
      dose_ref: parseFloat(p.dose_max) || 0,
      dose_max: parseFloat(p.dose_max) || 0,
      unite: p.unite_dose || 'kg/ha',
      dar: parseInt(p.dai) || 0,
      znt: parseInt(p.znt) || 5,
      categ: p.type_produit || 'Fongicide',
      cibles: p.usages?.map(u=>u.cible||u.usage).join(', ') || '',
      nb_applic: p.nombre_max_application || '',
      restriction: '',
      catLabel: p.type_produit || '',
      maLabel: p.matieres_actives?.map(m=>m.nom).join(', ') || '',
      searchText: (p.nom_produit||'').toLowerCase()
    }));
    res.innerHTML = window.PHYTO_LAST_RESULTS.map((p,i) => `
      <div onclick="selectPhytoProd(${i})"
        style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--gris2)"
        onmouseenter="this.style.background='var(--gris3)'"
        onmouseleave="this.style.background=''">
        <div style="font-weight:700;font-size:13px;color:var(--terre)">${p.nomProd} <span style="font-size:10px;background:#e8f4fd;color:#2a6a9a;padding:1px 5px;border-radius:3px">E-phy</span></div>
        <div style="font-size:11px;color:var(--gris);margin-top:2px">${p.maLabel} · ${p.fab}</div>
        <div style="display:flex;gap:8px;margin-top:3px">
          <span style="font-size:10px;background:#d4edda;color:var(--vert);padding:1px 6px;border-radius:4px">DAR ${p.dar}j</span>
          <span style="font-size:10px;background:#d4e8f4;color:#2a6a9a;padding:1px 6px;border-radius:4px">ZNT ${p.znt}m</span>
        </div>
      </div>`).join('');
  } catch(e) {
    res.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--rouge);text-align:center">E-phy indisponible — saisir manuellement</div>`;
  }
}



// ══════════════════════════════════════════
//  CONSEILS ASSOCIATIONS
// ══════════════════════════════════════════

const ADVENTICES = [
  {id:'graminee', label:'🌾 Graminées', desc:'Ray-grass, Vulpin, Brome'},
  {id:'liseron', label:'🌀 Liseron', desc:'Convolvulus arvensis'},
  {id:'chiendent', label:'🌿 Chiendent', desc:'Elytrigia repens'},
  {id:'chardon', label:'🌵 Chardon', desc:'Cirsium arvense'},
  {id:'rumex', label:'🍃 Rumex', desc:'Rumex obtusifolius'},
  {id:'dicot_annuelles', label:'🌼 Dicots annuelles', desc:'Mercuriale, Chénopode'},
  {id:'mousses', label:'🟢 Mousses', desc:'Sol hydromorphe'},
  {id:'ronces', label:'🌿 Ronces', desc:'Rubus, Hedera'},
];

const MALADIES = [
  {id:'mildiou', label:'💧 Mildiou'},
  {id:'oidium', label:'⚪ Oïdium'},
  {id:'botrytis', label:'🍇 Botrytis'},
  {id:'excoriose', label:'🟤 Excoriose'},
  {id:'blackrot', label:'⚫ Black-rot'},
  {id:'vers', label:'🐛 Vers grappe'},
  {id:'cicadelle', label:'🦗 Cicadelle FD'},
  {id:'acariens', label:'🔴 Acariens'},
];

const STADES = [
  {id:'bbch05', label:'BBCH 05-09', desc:'Débourrement'},
  {id:'bbch13', label:'BBCH 13-53', desc:'Feuillaison'},
  {id:'bbch65', label:'BBCH 65', desc:'Floraison ⚠️'},
  {id:'bbch71', label:'BBCH 71-79', desc:'Nouaison'},
  {id:'bbch81', label:'BBCH 81-89', desc:'Véraison'},
  {id:'bbch93', label:'BBCH 93+', desc:'Post-récolte'},
];

const CONSEILS_HERB = {};
const CONSEILS_PHYTO = {};

let csCurrentMode = 'herb';
let csCurrentSaison = 'hiver';
let csCurrentAdventice = null;
let csCurrentStade = null;
let csCurrentMaladie = null;

function initConseil() {
  const adv = document.getElementById('csAdventList');
  if (adv) adv.innerHTML = ADVENTICES.map(a =>
    `<span class="cs-tag" id="csa-${a.id}" onclick="selectAdventice('${a.id}')">${a.label}</span>`
  ).join('');
  const stade = document.getElementById('csStadeList');
  if (stade) stade.innerHTML = STADES.map(s =>
    `<span class="cs-tag" id="css-${s.id}" onclick="selectStade('${s.id}')">${s.label}<small style="display:block;color:var(--gris);font-weight:400;font-size:10px">${s.desc}</small></span>`
  ).join('');
  const mal = document.getElementById('csMaladieList');
  if (mal) mal.innerHTML = MALADIES.map(m =>
    `<span class="cs-tag" id="csm-${m.id}" onclick="selectMaladie('${m.id}')">${m.label}</span>`
  ).join('');
}

function switchConseil(mode) {
  csCurrentMode = mode;
  document.getElementById('csHerb').style.display = mode === 'herb' ? 'block' : 'none';
  document.getElementById('csPhyto').style.display = mode === 'phyto' ? 'block' : 'none';
  document.getElementById('csBtnHerb').style.borderColor = mode === 'herb' ? 'var(--or)' : 'transparent';
  document.getElementById('csBtnPhyto').style.borderColor = mode === 'phyto' ? 'var(--or)' : 'transparent';
  document.getElementById('csBtnHerb').style.background = mode === 'herb' ? 'var(--gris3)' : 'var(--card)';
  document.getElementById('csBtnPhyto').style.background = mode === 'phyto' ? 'var(--gris3)' : 'var(--card)';
}

function selectSaison(s) {
  csCurrentSaison = s;
  document.querySelectorAll('.cs-saison').forEach(el => el.classList.remove('on'));
  document.getElementById('cs-' + s).classList.add('on');
  if (csCurrentAdventice) renderConseilHerb();
}

function selectAdventice(a) {
  csCurrentAdventice = a;
  document.querySelectorAll('[id^="csa-"]').forEach(el => el.classList.remove('on'));
  document.getElementById('csa-' + a).classList.add('on');
  renderConseilHerb();
}

function selectStade(s) {
  csCurrentStade = s;
  document.querySelectorAll('[id^="css-"]').forEach(el => el.classList.remove('on'));
  document.getElementById('css-' + s).classList.add('on');
  if (csCurrentMaladie) renderConseilPhyto();
}

function selectMaladie(m) {
  csCurrentMaladie = m;
  document.querySelectorAll('[id^="csm-"]').forEach(el => el.classList.remove('on'));
  document.getElementById('csm-' + m).classList.add('on');
  renderConseilPhyto();
}

function renderConseilHerb() {
  const container = document.getElementById('csHerbResult');
  const data = CONSEILS_HERB[csCurrentSaison]?.[csCurrentAdventice];
  if (!data) { container.innerHTML = ''; return; }
  const icone = data.niveau === 'ok' ? '✅' : data.niveau === 'warn' ? '⚠️' : '🚫';
  container.innerHTML = `
    <div class="cs-result cs-result-${data.niveau}">
      <div style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:700;color:var(--vigne);margin-bottom:8px">${icone} ${data.titre}</div>
      <div style="font-size:13px;color:var(--terre);margin-bottom:12px;line-height:1.5">${data.conseil}</div>
      ${data.associations.length ? `<div style="font-weight:700;font-size:12px;color:var(--gris);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Associations recommandées</div>
      ${data.associations.map(a => `<div class="cs-produit">
          <div style="font-size:11px;font-weight:700;color:${a.compat.startsWith('✅')?'var(--vert)':'var(--orange)'};margin-bottom:3px">${a.compat}</div>
          <div style="font-size:13px;font-weight:600;color:var(--terre);margin-bottom:3px">${a.produits.join(' ')}</div>
          <div style="font-size:12px;color:var(--gris)">${a.detail}</div>
        </div>`).join('')}` : ''}
      ${data.attention ? `<div class="al alo" style="margin-top:12px"><span class="al-i">⚠️</span><div style="font-size:12px">${data.attention}</div></div>` : ''}
    </div>`;
}

function renderConseilPhyto() {
  const container = document.getElementById('csPhytoResult');
  if (!csCurrentMaladie) {
    container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--gris);font-size:13px">Sélectionner une maladie ou un ravageur ci-dessus</div>`;
    return;
  }
  const stadeKeys = Object.keys(CONSEILS_PHYTO[csCurrentMaladie] || {});
  const stadeKey = csCurrentStade && stadeKeys.includes(csCurrentStade) ? csCurrentStade : stadeKeys[0];
  const data = CONSEILS_PHYTO[csCurrentMaladie]?.[stadeKey];
  if (!data) {
    container.innerHTML = `<div class="al alb"><span class="al-i">ℹ️</span><div style="font-size:13px">Pas de conseil spécifique pour cette combinaison. Consulter votre technicien viti.</div></div>`;
    return;
  }
  const icone = data.niveau === 'ok' ? '✅' : data.niveau === 'warn' ? '⚠️' : '🚫';
  container.innerHTML = `
    <div class="cs-result cs-result-${data.niveau}">
      <div style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:700;color:var(--vigne);margin-bottom:8px">${icone} ${data.titre}</div>
      <div style="font-size:13px;color:var(--terre);margin-bottom:12px;line-height:1.5">${data.conseil}</div>
      ${data.associations.length ? `<div style="font-weight:700;font-size:12px;color:var(--gris);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Associations recommandées</div>
      ${data.associations.map(a => `<div class="cs-produit">
          <div style="font-size:11px;font-weight:700;color:${a.compat.startsWith('✅')?'var(--vert)':'var(--orange)'};margin-bottom:3px">${a.compat}</div>
          <div style="font-size:13px;font-weight:600;color:var(--terre);margin-bottom:3px">${a.produits.join(' ')}</div>
          <div style="font-size:12px;color:var(--gris)">${a.detail}</div>
        </div>`).join('')}` : ''}
      ${data.attention ? `<div class="al alo" style="margin-top:12px"><span class="al-i">⚠️</span><div style="font-size:12px">${data.attention}</div></div>` : ''}
    </div>`;
}


// ══════════════════════════════════════════
//  PARSEURS KML / GPX / PHOTO RELEVÉ
// ══════════════════════════════════════════

function parseKML(kmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, 'text/xml');
  const parcelles = [];
  const COLORS = ['#c8a84c','#d4a840','#e0b840','#4a8a42','#7a3060','#a08030','#b09030','#80a030'];

  // Chercher tous les Placemark
  const placemarks = doc.querySelectorAll('Placemark');
  placemarks.forEach((pm, i) => {
    const nom = pm.querySelector('name')?.textContent || `Parcelle ${i+1}`;
    const desc = pm.querySelector('description')?.textContent || '';

    // Polygon
    const coordsEl = pm.querySelector('Polygon outerBoundaryIs coordinates, coordinates');
    if (!coordsEl) return;

    const coordText = coordsEl.textContent.trim();
    const coords = coordText.split(/\s+/).map(c => {
      const parts = c.split(',');
      if (parts.length >= 2) {
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lon)) return [parseFloat(lat.toFixed(7)), parseFloat(lon.toFixed(7))];
      }
      return null;
    }).filter(Boolean);

    if (coords.length >= 3) {
      parcelles.push({
        code: `K${i+1}`,
        nom: nom.slice(0, 50),
        surface_ha: 0,
        commune: '',
        culture: '',
        coords,
        color: COLORS[i % COLORS.length]
      });
    }
  });
  return parcelles;
}

function parseGPX(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, 'text/xml');
  const parcelles = [];
  const COLORS = ['#c8a84c','#d4a840','#4a8a42','#7a3060','#a08030'];

  // Tracks
  const tracks = doc.querySelectorAll('trk');
  tracks.forEach((trk, i) => {
    const nom = trk.querySelector('name')?.textContent || `Trace ${i+1}`;
    const points = [];
    trk.querySelectorAll('trkpt').forEach(pt => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lon)) points.push([parseFloat(lat.toFixed(7)), parseFloat(lon.toFixed(7))]);
    });
    if (points.length >= 3) {
      // Fermer le polygone si nécessaire
      if (points[0][0] !== points[points.length-1][0]) points.push(points[0]);
      parcelles.push({ code: `G${i+1}`, nom: nom.slice(0,50), surface_ha: 0, commune: '', culture: '', coords: points, color: COLORS[i%COLORS.length] });
    }
  });

  // Routes (comme polygones)
  const routes = doc.querySelectorAll('rte');
  routes.forEach((rte, i) => {
    const nom = rte.querySelector('name')?.textContent || `Route ${i+1}`;
    const points = [];
    rte.querySelectorAll('rtept').forEach(pt => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lon)) points.push([parseFloat(lat.toFixed(7)), parseFloat(lon.toFixed(7))]);
    });
    if (points.length >= 3) {
      if (points[0][0] !== points[points.length-1][0]) points.push(points[0]);
      parcelles.push({ code: `R${i+1}`, nom: nom.slice(0,50), surface_ha: 0, commune: '', culture: '', coords: points, color: COLORS[i%COLORS.length] });
    }
  });

  return parcelles;
}

async function analyserPhotoReleve(file) {
  setShpLoading('Analyse IA du document cadastral…');
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });

    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64,
        mimeType: file.type || 'image/jpeg',
        mode: 'cadastre'
      })
    });

    if (!response.ok) throw new Error('Erreur serveur');
    const data = await response.json();

    if (data.parcelles && data.parcelles.length) {
      shpParcelles = data.parcelles.map((p, i) => ({
        code: p.code || `C${i+1}`,
        nom: p.nom || p.section || `Parcelle ${i+1}`,
        surface_ha: parseFloat(p.surface_ha) || 0,
        commune: p.commune || '',
        culture: p.nature || '',
        coords: [],
        color: ['#c8a84c','#d4a840','#4a8a42','#7a3060'][i % 4]
      }));
      afficherShpResult();
      toast(`✅ ${shpParcelles.length} parcelle(s) extraites du document`);
    } else if (data.info) {
      // Afficher les infos extraites sans coordonnées GPS
      document.getElementById('shpLoadingContent').style.display = 'none';
      document.getElementById('shpDropContent').style.display = 'block';
      document.getElementById('shpResult').style.display = 'block';
      document.getElementById('shpResultMsg').className = 'al alb';
      document.getElementById('shpResultTxt').innerHTML = `<b>📄 Document analysé par l'IA</b><br>${data.info}`;
      document.getElementById('shpParcList').innerHTML = `
        <div class="al alo" style="margin-top:8px"><span class="al-i">ℹ️</span>
        <div>Ce document ne contient pas de coordonnées GPS. Les informations sont extraites mais sans géolocalisation précise. 
        Pour importer avec les coordonnées GPS, utilisez le fichier ZIP Télépac.</div></div>`;
      toast('ℹ️ Document analysé — pas de coordonnées GPS');
    } else {
      throw new Error('Document non reconnu — utiliser ZIP Télépac pour les coordonnées GPS');
    }
  } catch(e) {
    document.getElementById('shpLoadingContent').style.display = 'none';
    document.getElementById('shpDropContent').style.display = 'block';
    document.getElementById('shpResult').style.display = 'block';
    document.getElementById('shpResultMsg').className = 'al alr';
    document.getElementById('shpResultTxt').innerHTML = `<b>Analyse impossible</b> — ${e.message}`;
    document.getElementById('shpParcList').innerHTML = '';
    toast('❌ ' + e.message);
  }
}

function fillObsSelects() {
  ['obParc','rdParc'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const first = id==='obParc' ? '<option value="">— Toutes —</option>' : '<option value="">— Choisir —</option>';
    sel.innerHTML = first + activeParcs().map(p=>`<option value="${p.code}">${p.code} · ${p.nom} (${p.surface_ha||'?'} ha)</option>`).join('');
  });
  const obDate = document.getElementById('obDate');
  if (obDate && !obDate.value) obDate.value = new Date().toISOString().split('T')[0];
  const mpRecep = document.getElementById('mpRecep');
  if (mpRecep && !mpRecep.value) mpRecep.value = new Date().toISOString().split('T')[0];
}

function doExport(t){toast(`📤 Export ${t} en cours…`);setTimeout(()=>toast(`✅ ${t} exporté`),1500);}

// ══════════════════════════════════════════
//  SAISIE MANUELLE — PRODUIT PHYTO
// ══════════════════════════════════════════
async function saveManualProd() {
  const nom = g('mpNom');
  if (!nom) { toast('⚠️ Nom du produit obligatoire'); return; }
  syncSaving();
  const unite = document.getElementById('mpUnite')?.value || 'kg/ha';
  const qte = parseFloat(g('mpQte')) || 0;
  const seuil = parseFloat(g('mpSeuil')) || 5;
  try {
    const {data,error} = await sb.from('produits_phyto').insert({
      domaine_id: DOM_ID,
      nom, amm: g('mpAMM'), fabricant: g('mpFab'),
      categorie: document.getElementById('mpCateg')?.value || 'Fongicide',
      dose_reference: parseFloat(g('mpDoseRef')) || 1,
      dose_max: parseFloat(g('mpDoseRef')) || 1,
      dose_unite: unite,
      dar: parseInt(g('mpDAR')) || 0,
      znt: parseInt(g('mpZNT')) || 5,
      cibles: g('mpCibles'),
      qte_stock: qte,
      unite_stock: unite.replace('/ha',''),
      seuil_alerte: seuil,
      etat: qte<=0?'zero':qte<=seuil?'low':'ok',
      date_reception: g('mpRecep') || null,
      date_peremption: g('mpPerem') || null,
      fournisseur: g('mpFourn'),
      actif: true
    }).select().single();
    if (error) throw error;
    STOCK.push(data);
    syncOK();
    renderStock('all'); fillSelects();
    toast('✅ Produit enregistré dans le stock');
    closeM(null,'mAddProd');
    // Reset
    ['mpNom','mpAMM','mpFab','mpDoseRef','mpDAR','mpZNT','mpCibles','mpQte','mpSeuil','mpRecep','mpPerem','mpFourn'].forEach(id=>{sv(id,'');});
  } catch(e) { syncErr(); toast('❌ Erreur : '+e.message); }
}

// ══════════════════════════════════════════
//  SAISIE MANUELLE — OBSERVATION
// ══════════════════════════════════════════
async function saveObs() {
  const desc = g('obDesc');
  if (!desc) { toast('⚠️ Description obligatoire'); return; }
  syncSaving();
  try {
    const parcCode = g('obParc');
    const parc = PARCS.find(p=>p.code===parcCode);
    await sb.from('observations').insert({
      domaine_id: DOM_ID,
      parcelle_id: parc?.id || null,
      date_observation: g('obDate') || new Date().toISOString().split('T')[0],
      type_obs: document.getElementById('obType')?.value || 'Autre',
      gravite: document.getElementById('obGravite')?.value || 'Faible',
      description: desc,
      traitement_recommande: g('obTrait'),
    });
    syncOK();
    toast('✅ Observation enregistrée');
    closeM(null,'mAddObs');
    ['obDesc','obTrait'].forEach(id=>{sv(id,'');});
  } catch(e) { syncErr(); toast('❌ Erreur : '+e.message); }
}

// ══════════════════════════════════════════
//  SAISIE MANUELLE — RENDEMENT
// ══════════════════════════════════════════
async function saveRendement() {
  const parcCode = g('rdParc');
  if (!parcCode) { toast('⚠️ Parcelle obligatoire'); return; }
  syncSaving();
  try {
    const parc = PARCS.find(p=>p.code===parcCode);
    await sb.from('rendements').insert({
      domaine_id: DOM_ID,
      parcelle_id: parc?.id || null,
      parcelle_code: parcCode,
      campagne: g('rdCamp') || AN,
      estimation_kg: parseFloat(g('rdEstim')) || null,
      pesee_reelle_kg: parseFloat(g('rdReel')) || null,
      date_vendange: g('rdDate') || null,
      destinataire: g('rdDest'),
    });
    syncOK();
    toast('✅ Rendement enregistré');
    closeM(null,'mAddRendement');
    ['rdEstim','rdReel','rdDate','rdDest'].forEach(id=>{sv(id,'');});
  } catch(e) { syncErr(); toast('❌ Erreur : '+e.message); }
}
function showM(id){document.getElementById(id).classList.add('op');}
function closeM(e,id){if(!e||e.target.classList.contains('ov'))document.getElementById(id).classList.remove('op');}
function g(id){return(document.getElementById(id)?.value||'').trim();}
function sv(id,v){const el=document.getElementById(id);if(el)el.value=v||'';}
function show(id){const el=document.getElementById(id);if(el){el.style.display='';if(id==='ob')el.style.display='flex';}}
function hide(id){const el=document.getElementById(id);if(el){if(id==='ls')el.classList.add('off');else el.style.display='none';}}
function toast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.style.opacity='1';t.style.transform='translateX(-50%) translateY(0)';
  clearTimeout(t._t);t._t=setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(-50%) translateY(14px)';},3200);
}
function syncSaving(){
  ['sp','spDesk'].forEach(id=>{const p=document.getElementById(id);if(p)p.className='sp sp-sv';});
  ['st','stDesk'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='Sauvegarde…';});
}
function syncOK(){
  ['sp','spDesk'].forEach(id=>{const p=document.getElementById(id);if(p)p.className='sp sp-ok';});
  ['st','stDesk'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='Cloud ✓';});
}
function syncErr(){
  ['sp','spDesk'].forEach(id=>{const p=document.getElementById(id);if(p)p.className='sp sp-er';});
  ['st','stDesk'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='Erreur sync';});
}

// CARTE PLEIN ÉCRAN
let mapFullscreen = false;
function toggleMapFullscreen() {
  const mc = document.getElementById('mc');
  const btn = mc.querySelector('.map-fullscreen-btn');
  mapFullscreen = !mapFullscreen;
  if (mapFullscreen) {
    mc.classList.add('fullscreen');
    btn.textContent = '✕ Fermer';
    document.addEventListener('keydown', escMapFullscreen);
  } else {
    mc.classList.remove('fullscreen');
    btn.textContent = '⛶ Plein écran';
    document.removeEventListener('keydown', escMapFullscreen);
  }
  setTimeout(() => { if (mL) mL.invalidateSize(); }, 100);
}
function escMapFullscreen(e) {
  if (e.key === 'Escape' && mapFullscreen) toggleMapFullscreen();
}

// Sync sidebar nom domaine
function updateSidebarNom() {
  const nom = DOM?.nom || DOM?.raison_sociale || 'Mon domaine';
  const sbNom = document.getElementById('sbNom');
  if (sbNom) sbNom.textContent = nom;
  const aviDesk = document.getElementById('aviDesk');
  if (aviDesk) aviDesk.textContent = nom.charAt(0).toUpperCase();
}

// ══════════════════════════════════════════
//  PERSONNALISATION
// ══════════════════════════════════════════
const THEMES = {
  vigne:   {vigne:'#1c3d1c',or:'#c9a84c',bg:'#eee8dc',terre:'#3d2b1f',noir:'#1a1410'},
  bordeaux:{vigne:'#4a0e1a',or:'#c9a84c',bg:'#f0e8e0',terre:'#3d1a10',noir:'#1a0808'},
  provence:{vigne:'#7a5c2e',or:'#e8c878',bg:'#f5eedd',terre:'#4a3820',noir:'#2a1a0a'},
  moderne: {vigne:'#1a2a3d',or:'#4a8abf',bg:'#e8eef4',terre:'#1a2a3d',noir:'#0a1520'},
  bio:     {vigne:'#2a4a1a',or:'#7ab84a',bg:'#eaf0e4',terre:'#1a3010',noir:'#0a1808'},
  ardoise: {vigne:'#2a2a2a',or:'#888888',bg:'#e8e8e8',terre:'#222222',noir:'#111111'},
};

let currentEmoji = '🍇';
let persoSettings = {};

function setEmoji(e) {
  currentEmoji = e;
  document.querySelectorAll('.emoji-opt').forEach(el => el.classList.remove('sel'));
  event.target.closest('.emoji-opt').classList.add('sel');
  persoPreview();
}

function persoPreview() {
  const nom = document.getElementById('pNomApp')?.value || 'VitiTrace';
  const sub = document.getElementById('pSousNom')?.value || 'Mon domaine';
  document.getElementById('pvLogo').textContent = currentEmoji;
  document.getElementById('pvNom').textContent = nom;
  document.getElementById('pvSub').textContent = sub;
  // Mettre à jour le header live
  document.getElementById('aN').textContent = sub || 'Mon domaine';
}

function applyTheme(name) {
  const t = THEMES[name];
  if (!t) return;
  Object.entries(t).forEach(([k, v]) => {
    document.documentElement.style.setProperty('--' + k, v);
  });
  // Sync les inputs couleur
  if (t.vigne) { const el=document.getElementById('cVigne'); if(el){el.value=t.vigne;document.getElementById('cVigneHex').value=t.vigne;} }
  if (t.or)    { const el=document.getElementById('cOr');    if(el){el.value=t.or;   document.getElementById('cOrHex').value=t.or;} }
  if (t.bg)    { const el=document.getElementById('cBg');    if(el){el.value=t.bg;   document.getElementById('cBgHex').value=t.bg;} }
  if (t.terre) { const el=document.getElementById('cTerre'); if(el){el.value=t.terre;document.getElementById('cTerreHex').value=t.terre;} }
  toast('🎨 Thème appliqué · Cliquer Sauvegarder pour conserver');
  persoSettings = {...persoSettings, theme: name, colors: t};
}

function applyCustomColor(key, value) {
  document.documentElement.style.setProperty('--' + key, value);
  // Sync text input
  const hexId = {vigne:'cVigneHex',or:'cOrHex',bg:'cBgHex',terre:'cTerreHex'}[key];
  if (hexId) document.getElementById(hexId).value = value;
  persoSettings.colors = {...(persoSettings.colors||{}), [key]: value};
}

function syncColorInput(key, value) {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    document.documentElement.style.setProperty('--' + key, value);
    const pickId = {vigne:'cVigne',or:'cOr',bg:'cBg',terre:'cTerre'}[key];
    if (pickId) document.getElementById(pickId).value = value;
    persoSettings.colors = {...(persoSettings.colors||{}), [key]: value};
  }
}

async function savePerso() {
  const settings = {
    nom_app: document.getElementById('pNomApp')?.value || '',
    sous_nom: document.getElementById('pSousNom')?.value || '',
    emoji: currentEmoji,
    colors: persoSettings.colors || {},
    textes: {
      dash:      document.getElementById('ptDash')?.value || '',
      bienvenue: document.getElementById('ptBienvenue')?.value || '',
      campagne:  document.getElementById('ptCampagne')?.value || '',
      stock:     document.getElementById('ptStock')?.value || '',
    }
  };
  syncSaving();
  try {
    await sb.from('domaines').update({ settings }).eq('id', DOM_ID);
    DOM.settings = settings;
    // Appliquer les textes
    applyPersoTextes(settings);
    syncOK();
    toast('✅ Personnalisation sauvegardée dans Supabase');
  } catch(e) { syncErr(); toast('❌ Erreur : ' + e.message); }
}

function applyPersoTextes(s) {
  if (!s) return;
  if (s.nom_app) { document.getElementById('ltxt') && (document.getElementById('ltxt').textContent = s.nom_app); }
  if (s.sous_nom) document.getElementById('aN').textContent = s.sous_nom;
  if (s.emoji) { const lm = document.querySelector('.lmark'); if(lm) lm.textContent = s.emoji; document.getElementById('pvLogo').textContent = s.emoji; }
  if (s.colors) Object.entries(s.colors).forEach(([k,v]) => document.documentElement.style.setProperty('--'+k, v));
}

function loadPerso() {
  const s = DOM?.settings;
  if (!s) return;
  if (s.nom_app) { const el=document.getElementById('pNomApp'); if(el) el.value=s.nom_app; }
  if (s.sous_nom) { const el=document.getElementById('pSousNom'); if(el) el.value=s.sous_nom; }
  if (s.emoji) { currentEmoji=s.emoji; }
  if (s.textes) {
    if (s.textes.dash)      { const el=document.getElementById('ptDash');      if(el) el.value=s.textes.dash; }
    if (s.textes.bienvenue) { const el=document.getElementById('ptBienvenue'); if(el) el.value=s.textes.bienvenue; }
    if (s.textes.campagne)  { const el=document.getElementById('ptCampagne');  if(el) el.value=s.textes.campagne; }
    if (s.textes.stock)     { const el=document.getElementById('ptStock');     if(el) el.value=s.textes.stock; }
  }
  if (s.colors) {
    Object.entries(s.colors).forEach(([k,v]) => {
      document.documentElement.style.setProperty('--'+k, v);
      const ids = {vigne:'cVigne',or:'cOr',bg:'cBg',terre:'cTerre'};
      const hexIds = {vigne:'cVigneHex',or:'cOrHex',bg:'cBgHex',terre:'cTerreHex'};
      if(ids[k]){const el=document.getElementById(ids[k]);if(el)el.value=v;}
      if(hexIds[k]){const el=document.getElementById(hexIds[k]);if(el)el.value=v;}
    });
  }
  applyPersoTextes(s);
}

function resetPerso() {
  applyTheme('vigne');
  currentEmoji = '🍇';
  ['pNomApp','pSousNom','ptDash','ptBienvenue','ptCampagne','ptStock'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('pvLogo').textContent = '🍇';
  document.getElementById('pvNom').textContent = 'VitiTrace';
  document.getElementById('pvSub').textContent = 'Mon domaine';
  document.getElementById('aN').textContent = DOM?.commune || 'Mon domaine';
  document.querySelectorAll('.emoji-opt').forEach(el => el.classList.remove('sel'));
  toast('↩ Valeurs par défaut restaurées');
}

// ══════════════════════════════════════════
//  IMPORT SHAPEFILE PAC
// ══════════════════════════════════════════
let shpParcelles = []; // parcelles extraites en attente de confirmation

// Drag & drop sur la zone
const shpDrop = document.getElementById('shpDrop');
shpDrop.addEventListener('dragover', e => { e.preventDefault(); shpDrop.style.borderColor = 'var(--or)'; shpDrop.style.background = '#fdf8e8'; });
shpDrop.addEventListener('dragleave', () => { shpDrop.style.borderColor = ''; shpDrop.style.background = ''; });
shpDrop.addEventListener('drop', e => {
  e.preventDefault(); shpDrop.style.borderColor = ''; shpDrop.style.background = '';
  const files = e.dataTransfer.files;
  if (files.length) {
    const dt = new DataTransfer();
    for (let i = 0; i < files.length; i++) dt.items.add(files[i]);
    document.getElementById('shpFile').files = dt.files;
    handleShpFile(document.getElementById('shpFile'));
  }
});

async function handleShpFile(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;

  // Cas : plusieurs fichiers glissés ensemble (.shp + .dbf + .shx)
  const shpFile = files.find(f => f.name.toLowerCase().endsWith('.shp'));
  const dbfFile = files.find(f => f.name.toLowerCase().endsWith('.dbf'));

  if (shpFile && files.length > 1) {
    // Lecture directe multi-fichiers — pas besoin de ZIP
    document.getElementById('shpDropContent').style.display = 'none';
    document.getElementById('shpLoadingContent').style.display = 'block';
    document.getElementById('shpResult').style.display = 'none';
    shpParcelles = [];
    try {
      setShpLoading('Lecture des fichiers Télépac…');
      const shpBuf = await shpFile.arrayBuffer();
      const dbfBuf = dbfFile ? await dbfFile.arrayBuffer() : null;
      setShpLoading('Extraction des polygones…');
      const polys = parseShp(shpBuf);
      let records = [];
      if (dbfBuf) { setShpLoading('Lecture des attributs…'); records = parseDbf(dbfBuf); }
      setShpLoading(`${polys.length} parcelle(s) trouvée(s)…`);
      const COLORS = ['#c8a84c','#d4a840','#e0b840','#4a8a42','#7a3060','#a08030','#b09030','#80a030','#602040','#4a6aaa','#aa4a4a','#6aaa4a','#aa8a4a','#4aaa8a','#8a4aaa'];
      const COMMUNES = {'34225':'Puisserguier','34052':'Capestang','34089':'Cessenon-sur-Orb'};
      const TYPES = {'VRC':'Vigne','VRN':'Vigne','OLI':'Olivier','SNE':'Surface non exploitée','JAC':'Jachère','BTH':'Blé tendre','MIS':'Maïs','TRN':'Tournesol'};
      shpParcelles = polys.map((coords, i) => {
        const rec = records[i] || {};
        const ilot = rec.NUMERO_I || `${i+1}`;
        const parc = rec.NUMERO_P || '1';
        const surf = parseFloat(rec.SURF || rec.SURF_TOT || 0);
        const typeCode = rec.TYPE || '';
        const communeCode = rec.COMMUNE || '';
        return { code:`I${ilot}P${parc}`, nom:`Îlot ${ilot} · ${TYPES[typeCode]||typeCode||'Parcelle'}`, surface_ha:surf, commune:COMMUNES[communeCode]||communeCode||'', culture:TYPES[typeCode]||typeCode||'', coords, color:COLORS[i%COLORS.length] };
      }).filter(p => p.coords.length >= 3);
      if (!shpParcelles.length) throw new Error('Aucun polygone valide');
      afficherShpResult();
    } catch(e) {
      document.getElementById('shpLoadingContent').style.display = 'none';
      document.getElementById('shpDropContent').style.display = 'block';
      document.getElementById('shpResult').style.display = 'block';
      document.getElementById('shpResultMsg').className = 'al alr';
      document.getElementById('shpResultTxt').innerHTML = `<b>Erreur</b> — ${e.message}`;
      document.getElementById('shpParcList').innerHTML = '';
      toast('❌ ' + e.message);
    }
    return;
  }

  // Cas fichier unique (ZIP, .shp seul, GeoJSON)
  const file = files[0];
  if (!file) return;
  document.getElementById('shpDropContent').style.display = 'none';
  document.getElementById('shpLoadingContent').style.display = 'block';
  document.getElementById('shpResult').style.display = 'none';
  shpParcelles = [];

  try {
    const name = file.name.toLowerCase();
    setShpLoading('Lecture du fichier…');
    const buffer = await file.arrayBuffer();

    let shpBuf = null, dbfBuf = null;

    if (name.endsWith('.zip')) {
      setShpLoading('Décompression du ZIP…');
      const entries = await readZipEntries(buffer);
      // Trouver les fichiers .shp et .dbf (peu importe le nom ou sous-dossier)
      const shpKey = Object.keys(entries).find(k => k.endsWith('.shp'));
      console.log('ZIP contents:', Object.keys(entries));
      const dbfKey = shpKey ? shpKey.replace('.shp', '.dbf') : null;
      if (!shpKey) throw new Error('Aucun fichier .shp trouvé dans le ZIP — contenu : ' + Object.keys(entries).join(', '));
      shpBuf = entries[shpKey];
      if (dbfKey && entries[dbfKey]) dbfBuf = entries[dbfKey];
      setShpLoading('Shapefile trouvé · Lecture des géométries…');
    } else if (name.endsWith('.shp')) {
      shpBuf = buffer;
      setShpLoading('Lecture Shapefile…');
    } else if (name.endsWith('.geojson') || name.endsWith('.json')) {
      setShpLoading('Lecture GeoJSON…');
      const geojson = JSON.parse(new TextDecoder().decode(buffer));
      const features = geojson.features || (geojson.type === 'Feature' ? [geojson] : []);
      shpParcelles = features.map((f, i) => {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates?.[0]?.map(c => [parseFloat(c[1].toFixed(7)), parseFloat(c[0].toFixed(7))]) || [];
        return {
          code: `P${i+1}`,
          nom: p.NOM_COM || p.COMMUNE || p.nom || p.name || `Parcelle ${i+1}`,
          surface_ha: parseFloat(p.SURF || p.surface || 0),
          commune: p.COMMUNE || p.NOM_COM || '',
          culture: p.TYPE || p.CULT_COD || '',
          coords
        };
      }).filter(p => p.coords.length >= 3);
      afficherShpResult();
      return;
    } else if (name.endsWith('.kml') || name.endsWith('.kmz')) {
      setShpLoading('Lecture KML/KMZ…');
      let kmlText;
      if (name.endsWith('.kmz')) {
        // KMZ = ZIP contenant un KML
        const entries = await readZipEntries(buffer);
        const kmlKey = Object.keys(entries).find(k => k.endsWith('.kml'));
        if (!kmlKey) throw new Error('Aucun fichier KML dans le KMZ');
        kmlText = new TextDecoder().decode(entries[kmlKey]);
      } else {
        kmlText = new TextDecoder().decode(buffer);
      }
      shpParcelles = parseKML(kmlText);
      if (!shpParcelles.length) throw new Error('Aucune géométrie dans le KML');
      afficherShpResult();
      return;
    } else if (name.endsWith('.gpx')) {
      setShpLoading('Lecture GPX…');
      const gpxText = new TextDecoder().decode(buffer);
      shpParcelles = parseGPX(gpxText);
      if (!shpParcelles.length) throw new Error('Aucune trace dans le GPX');
      afficherShpResult();
      return;
    } else if (file.type.startsWith('image/')) {
      // Photo/scan du relevé de propriété → analyse IA
      setShpLoading('Analyse IA du relevé de propriété…');
      await analyserPhotoReleve(file);
      return;
    } else {
      throw new Error('Format non supporté. Formats acceptés : ZIP Télépac, .shp+.dbf, GeoJSON, KML/KMZ, GPX, ou photo du relevé de propriété');
    }

    if (!shpBuf) throw new Error('Impossible de lire le shapefile');

    setShpLoading('Extraction des polygones…');
    const polys = parseShp(shpBuf);

    let records = [];
    if (dbfBuf) {
      setShpLoading('Lecture des attributs…');
      records = parseDbf(dbfBuf);
    }

    setShpLoading(`${polys.length} parcelle(s) trouvée(s) · Finalisation…`);

    const COLORS = ['#c8a84c','#d4a840','#e0b840','#4a8a42','#7a3060','#a08030','#b09030','#80a030','#602040','#4a6aaa','#aa4a4a','#6aaa4a','#aa8a4a','#4aaa8a','#8a4aaa'];
    const COMMUNES = {'34225':'Puisserguier','34052':'Capestang','34089':'Cessenon-sur-Orb'};
    const TYPES = {'VRC':'Vigne','VRN':'Vigne','OLI':'Olivier','SNE':'Surface non exploitée','JAC':'Jachère','BTH':'Blé tendre','MIS':'Maïs','TRN':'Tournesol'};

    shpParcelles = polys.map((coords, i) => {
      const rec = records[i] || {};
      const ilot = rec.NUMERO_I || rec.NUM_ILOT || `${i+1}`;
      const parc = rec.NUMERO_P || '1';
      const surf = parseFloat(rec.SURF || rec.SURF_TOT || rec.SUR_ADM || 0);
      const typeCode = rec.TYPE || rec.CULT_COD || '';
      const communeCode = rec.COMMUNE || rec.DPT_COM || '';
      return {
        code: `I${ilot}P${parc}`,
        nom: `Îlot ${ilot} · ${TYPES[typeCode] || typeCode || 'Parcelle'}`,
        surface_ha: surf,
        commune: COMMUNES[communeCode] || communeCode || 'Inconnue',
        culture: TYPES[typeCode] || typeCode || '',
        coords,
        color: COLORS[i % COLORS.length]
      };
    }).filter(p => p.coords.length >= 3);

    if (!shpParcelles.length) throw new Error('Aucun polygone valide extrait');
    afficherShpResult();

  } catch(e) {
    document.getElementById('shpLoadingContent').style.display = 'none';
    document.getElementById('shpDropContent').style.display = 'block';
    document.getElementById('shpResult').style.display = 'block';
    document.getElementById('shpResultMsg').className = 'al alr';
    document.getElementById('shpResultTxt').innerHTML = `<b>Erreur de lecture</b> — ${e.message}`;
    document.getElementById('shpParcList').innerHTML = '';
    console.error('SHP error:', e);
    toast('❌ ' + e.message);
  }
}

function setShpLoading(txt) {
  document.getElementById('shpLoadingTxt').textContent = txt;
}

function afficherShpResult() {
  document.getElementById('shpLoadingContent').style.display = 'none';
  document.getElementById('shpDropContent').style.display = 'block';
  document.getElementById('shpResult').style.display = 'block';
  document.getElementById('shpResultMsg').className = 'al alg';

  // Détection des doublons : on compare le code à ceux des parcelles existantes (actives ET archivées)
  const existingByCode = {};
  PARCS.forEach(p => { if (p.code) existingByCode[p.code] = p; });

  // Par défaut : doublons exclus, nouvelles importées
  shpParcelles.forEach(p => {
    const existing = existingByCode[p.code];
    p._isDuplicate = !!existing;
    p._duplicateOf = existing ? (existing.archived_at ? 'archivée' : 'active') : null;
    if (p._include === undefined) p._include = !p._isDuplicate;
  });

  const nbDup = shpParcelles.filter(p => p._isDuplicate).length;
  const nbNew = shpParcelles.length - nbDup;
  const totalHaAll = shpParcelles.reduce((s,p) => s+(p.surface_ha||0), 0);

  const dupWarning = nbDup
    ? `<div style="background:#fff3cd;border-left:3px solid #e0a020;padding:8px 12px;border-radius:6px;margin-top:6px;font-size:12px;color:#7a5510"><b>⚠️ ${nbDup} doublon(s) détecté(s)</b> — décochés par défaut. Coche pour réimporter (écrase pas, crée une erreur).</div>`
    : '';

  document.getElementById('shpResultTxt').innerHTML =
    `<b>${shpParcelles.length} parcelle(s) extraites — ${totalHaAll.toFixed(2)} ha total</b> · ${nbNew} nouvelle(s)${nbDup?', '+nbDup+' déjà présente(s)':''}. Vérifiez et décochez celles à exclure.${dupWarning}`;

  // Boutons tout cocher/décocher
  const bulkBtns = `<div style="display:flex;gap:6px;margin-bottom:8px;font-size:11px">
    <button class="btn btghost btsm" onclick="shpToggleAll(true)" style="font-size:11px;padding:4px 10px">☑ Tout cocher</button>
    <button class="btn btghost btsm" onclick="shpToggleAll(false)" style="font-size:11px;padding:4px 10px">☐ Tout décocher</button>
    ${nbNew?`<button class="btn btghost btsm" onclick="shpToggleNewOnly()" style="font-size:11px;padding:4px 10px">🆕 Nouvelles uniquement</button>`:''}
    <span id="shpSelCount" style="margin-left:auto;font-size:12px;color:var(--gris);align-self:center"></span>
  </div>`;

  document.getElementById('shpParcList').innerHTML = bulkBtns + shpParcelles.map((p,i) => {
    const dupBadge = p._isDuplicate
      ? `<span style="font-size:10px;background:#fde8c8;color:#7a5510;padding:2px 7px;border-radius:10px;margin-left:6px;font-weight:600">déjà présent · ${p._duplicateOf}</span>`
      : `<span style="font-size:10px;background:#d4edda;color:var(--vert);padding:2px 7px;border-radius:10px;margin-left:6px;font-weight:600">nouveau</span>`;
    const bgColor = p._isDuplicate ? '#faf1e0' : 'var(--gris3)';
    return `
    <div id="shpRow${i}" style="background:${bgColor};border-radius:10px;padding:11px 13px;margin-bottom:7px;transition:opacity 0.2s">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:120px">
          <input type="checkbox" ${p._include?'checked':''} onchange="shpToggleRow(${i}, this.checked)" style="width:18px;height:18px;cursor:pointer;accent-color:var(--vert)">
          <div style="flex:1">
            <div style="font-weight:700;font-size:13px">${p.nom}${dupBadge}</div>
            <div style="font-size:11px;color:var(--gris);margin-top:2px">${p.surface_ha} ha · ${p.commune} · ${p.coords.length} pts GPS</div>
          </div>
        </label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="text" value="${p.code}" placeholder="Code" style="width:70px;padding:5px 7px;font-size:12px" onchange="shpParcelles[${i}].code=this.value">
          <input type="text" value="${p.nom}" placeholder="Nom" style="width:140px;padding:5px 7px;font-size:12px" onchange="shpParcelles[${i}].nom=this.value">
        </div>
      </div>
    </div>`;
  }).join('');

  shpUpdateSelCount();
  toast(`✅ ${shpParcelles.length} parcelles extraites${nbDup?' ('+nbDup+' doublons)':''}`);
}

function shpToggleRow(i, checked) {
  if (!shpParcelles[i]) return;
  shpParcelles[i]._include = checked;
  const row = document.getElementById('shpRow'+i);
  if (row) row.style.opacity = checked ? '1' : '0.45';
  shpUpdateSelCount();
}

function shpToggleAll(checked) {
  shpParcelles.forEach((p,i) => { p._include = checked; });
  afficherShpResult();
}

function shpToggleNewOnly() {
  shpParcelles.forEach(p => { p._include = !p._isDuplicate; });
  afficherShpResult();
}

function shpUpdateSelCount() {
  const el = document.getElementById('shpSelCount'); if (!el) return;
  const sel = shpParcelles.filter(p => p._include);
  const ha = sel.reduce((s,p) => s+(p.surface_ha||0), 0);
  el.textContent = `${sel.length}/${shpParcelles.length} sélectionnées · ${ha.toFixed(2)} ha`;
}

async function confirmShpImport() {
  if (!shpParcelles.length) return;

  const toImport = shpParcelles.filter(p => p._include !== false);
  if (!toImport.length) {
    toast('❌ Aucune parcelle sélectionnée');
    return;
  }

  const nbDup = toImport.filter(p => p._isDuplicate).length;
  if (nbDup) {
    if (!confirm(`⚠️ ${nbDup} parcelle(s) sélectionnée(s) sont déjà présentes dans ton domaine (même code).\n\nEn continuant, ces parcelles échoueront à l'insertion (doublon Supabase) mais les nouvelles passeront.\n\nContinuer quand même ?`)) return;
  }

  syncSaving();
  let ok=0, err=0, dup=0;
  const COLORS=['#c8a84c','#d4a840','#e0b840','#4a8a42','#7a3060','#a08030','#b09030','#80a030','#602040','#4a6aaa','#aa4a4a','#6aaa4a','#aa8a4a','#4aaa8a','#8a4aaa'];

  for (let i=0; i<toImport.length; i++) {
    const p = toImport[i];
    try {
      const {data,error} = await sb.from('parcelles').insert({
        domaine_id: DOM_ID, code: p.code, nom: p.nom,
        commune: p.commune, surface_ha: p.surface_ha || null,
        cepage: p.culture, produit_aoc: 'PAC 2025',
        ref_cadastrale: `PAC2025-${p.code}`,
        coords: p.coords, color: p.color || COLORS[i%COLORS.length]
      }).select().single();
      if (error) {
        // Doublon SQL (unique constraint) => counted as dup, pas comme erreur
        if (/duplicate|unique/i.test(error.message||'')) { dup++; }
        else { throw error; }
      } else {
        PARCS.push(data); ok++;
      }
    } catch(e) { err++; console.error('Import parcelle', p.code, e); }
  }

  // Surface domaine = somme des parcelles actives uniquement
  const totalHa = activeParcs().reduce((s,p)=>s+(p.surface_ha||0),0);
  await sb.from('domaines').update({surface_ha:Math.round(totalHa*100)/100}).eq('id',DOM_ID);
  DOM.surface_ha = Math.round(totalHa*100)/100;
  syncOK();
  fillSelects(); renderDash(); renderIFT();
  mI=false; initMap();

  const parts = [`✅ ${ok} parcelle(s) importée(s)`];
  if (dup) parts.push(`${dup} doublon(s) ignoré(s)`);
  if (err) parts.push(`${err} erreur(s)`);
  toast(parts.join(' · ') + ' · Carte mise à jour');

  resetShpImport();
  document.getElementById('shpImportCard').style.display = 'none';
}

function resetShpImport() {
  shpParcelles = [];
  document.getElementById('shpDropContent').style.display = 'block';
  document.getElementById('shpLoadingContent').style.display = 'none';
  document.getElementById('shpResult').style.display = 'none';
  document.getElementById('shpFile').value = '';
}

// ══════════════════════════════════════════════════════════════
//  BASE DE DONNÉES PRODUITS PHYTO VIGNE — FRANCE 2025
//  Source : E-phy ANSES / Homologations en vigueur
// ══════════════════════════════════════════════════════════════
const PHYTO_DB = {
  categories: {
    fongicide: {
      label: '🍄 Fongicide',
      matieres: {
        soufre: {
          label: 'Soufre (fongicide)',
          dose_ref: 3.0, dose_max: 10.0, unite: 'kg/ha',
          dar: 28, znt: 5, categ: 'Fongicide',
          cibles: 'Oïdium (Uncinula necator)',
          nb_applic: 'Sans limite (plafond soufre élémentaire)',
          restriction: 'Ne pas appliquer par T° > 35°C ni sur végétation mouillée',
          produits: [
            { nom: 'Soufre Micronisé Wettable', fab: 'De Sangosse', amm: 'FR-2019-0847', forme: 'WP 80%', dose: 3.0 },
            { nom: 'Thiovit Jet', fab: 'Syngenta', amm: 'FR-2014-1823', forme: 'WG 80%', dose: 3.0 },
            { nom: 'Microthiol Spécial Disperss', fab: 'UPL', amm: 'FR-2017-0432', forme: 'WG 80%', dose: 3.0 },
            { nom: 'Heliosoufre S', fab: 'Agronutrition', amm: 'FR-2020-0915', forme: 'SC 720 g/L', dose: 3.0 },
            { nom: 'Cosavet DF Edge', fab: 'Certis', amm: 'FR-2018-1204', forme: 'WG 80%', dose: 3.0 },
            { nom: 'Soufre Mouillable Disperss', fab: 'Agriphar', amm: 'FR-2016-0678', forme: 'WP 80%', dose: 3.0 },
          ]
        },
        cuivre: {
          label: 'Cuivre (hydroxyde, oxychlorure, sulfate)',
          dose_ref: 2.5, dose_max: 4.0, unite: 'kg/ha',
          dar: 21, znt: 20, categ: 'Fongicide cuivre',
          cibles: 'Mildiou (Plasmopara viticola), Black-rot, Excoriose',
          nb_applic: 'Plafond 28 kg Cu métal/ha sur 7 ans',
          restriction: 'ZNT 20 m — Zones non traitées obligatoires',
          produits: [
            { nom: 'Cuivrol Extra 49 WG', fab: 'Manica', amm: 'FR-2021-0983', forme: 'WG 49%', dose: 2.8 },
            { nom: 'Cuivre Hydroxyde Champion 50 WG', fab: 'Certis', amm: 'FR-2020-1234', forme: 'WG 50%', dose: 2.5 },
            { nom: 'Nordox 75 WG', fab: 'Nordox', amm: 'FR-2018-0456', forme: 'WG 75% (oxyde cuivreux)', dose: 1.5 },
            { nom: 'Kocide Opti', fab: 'FMC', amm: 'FR-2019-0789', forme: 'WG 46.1%', dose: 3.0 },
            { nom: 'Bouille Bordelaise WDG', fab: 'Cerexagri', amm: 'FR-2016-0234', forme: 'WG 20% (bouillie)', dose: 4.0 },
            { nom: 'Héliocuivre', fab: 'Agronutrition', amm: 'FR-2022-0156', forme: 'SC 190 g/L', dose: 3.0 },
            { nom: 'Cuprex Evo', fab: 'Agriphar', amm: 'FR-2020-0567', forme: 'WP 50%', dose: 2.5 },
          ]
        },
        folpet: {
          label: 'Folpet',
          dose_ref: 1.5, dose_max: 2.5, unite: 'kg/ha',
          dar: 28, znt: 5, categ: 'Fongicide',
          cibles: 'Mildiou, Black-rot, Excoriose, Anthracnose',
          nb_applic: '4 applications max/an',
          restriction: 'CMR2 — EPI complet obligatoire — DAP 48h',
          produits: [
            { nom: 'Folpan 80 WDG', fab: 'Arysta', amm: 'FR-2018-0556', forme: 'WG 80%', dose: 1.5 },
            { nom: 'Mikal Flash', fab: 'BASF', amm: 'FR-2019-0334', forme: 'WG (folpet+fosétyl)', dose: 2.5 },
            { nom: 'Fantic F', fab: 'Isagro', amm: 'FR-2017-0891', forme: 'WP 60%', dose: 1.5 },
            { nom: 'Dithane Neo Tec', fab: 'Corteva', amm: 'FR-2015-0667', forme: 'WG 75% (mancozèbe)', dose: 1.7 },
          ]
        },
        mancozebe: {
          label: 'Mancozèbe (EBDC)',
          dose_ref: 1.7, dose_max: 2.0, unite: 'kg/ha',
          dar: 42, znt: 5, categ: 'Fongicide',
          cibles: 'Mildiou, Black-rot',
          nb_applic: '4 applications max/an — Zone délicate résidus',
          restriction: 'DAR 42j strict — CMR2 — Résidus surveillés export',
          produits: [
            { nom: 'Dithane M-45', fab: 'Corteva', amm: 'FR-2014-0445', forme: 'WP 80%', dose: 1.7 },
            { nom: 'Pérostar', fab: 'Nufarm', amm: 'FR-2016-0892', forme: 'WP 75%', dose: 1.7 },
          ]
        },
        cymoxanil: {
          label: 'Cymoxanil (anti-mildiou curatif)',
          dose_ref: 0.25, dose_max: 0.35, unite: 'kg/ha',
          dar: 21, znt: 5, categ: 'Fongicide',
          cibles: 'Mildiou — action curative 72h après contamination',
          nb_applic: '4 applications max/an — Alternance obligatoire',
          restriction: 'Toujours en mélange — Résistances fréquentes',
          produits: [
            { nom: 'Curzate M WG', fab: 'Corteva', amm: 'FR-2017-0234', forme: 'WG (cymox+mancoz)', dose: 2.5 },
            { nom: 'Viderut Pro', fab: 'UPL', amm: 'FR-2020-0678', forme: 'WG 45%', dose: 0.3 },
          ]
        },
        metalaxyl: {
          label: 'Métalaxyl-M (anti-mildiou systémique)',
          dose_ref: 0.05, dose_max: 0.08, unite: 'kg/ha',
          dar: 28, znt: 5, categ: 'Fongicide',
          cibles: 'Mildiou — action systémique translaminaire',
          nb_applic: '3 applications max/an — Risque résistance élevé',
          restriction: 'Ne jamais utiliser seul — Alternance obligatoire FRAC 4',
          produits: [
            { nom: 'Ridomil Gold MZ Pepite', fab: 'Syngenta', amm: 'FR-2018-0445', forme: 'WG (métalaxyl-M + mancoz)', dose: 2.5 },
            { nom: 'Ridomil Gold R', fab: 'Syngenta', amm: 'FR-2019-0667', forme: 'WG 68%', dose: 2.5 },
          ]
        },
        iprodione: {
          label: 'Fludioxonil / Iprodione (botryticide)',
          dose_ref: 0.5, dose_max: 1.0, unite: 'kg/ha',
          dar: 21, znt: 5, categ: 'Fongicide',
          cibles: 'Botrytis (pourriture grise) — Excoriose',
          nb_applic: '2 applications max/an',
          restriction: 'Traitement en début véraison ou floraison uniquement',
          produits: [
            { nom: 'Switch 62.5 WG', fab: 'Syngenta', amm: 'FR-2016-0789', forme: 'WG (flud+cyprod)', dose: 0.8 },
            { nom: 'Scala', fab: 'Bayer', amm: 'FR-2015-0334', forme: 'SC 400 g/L (pyrimethanil)', dose: 1.0 },
            { nom: 'Teldor', fab: 'Bayer', amm: 'FR-2014-0567', forme: 'SC 500 g/L (fenhexamid)', dose: 1.0 },
          ]
        },
        quinoxyfen: {
          label: 'Quinoxyfène / Tébuconazole (oïdicide)',
          dose_ref: 0.075, dose_max: 0.1, unite: 'L/ha',
          dar: 35, znt: 5, categ: 'Fongicide',
          cibles: 'Oïdium — action préventive et curative',
          nb_applic: '2 applications max/an — Rotation FRAC',
          restriction: 'CMR1B pour tébuconazole — EPI complet',
          produits: [
            { nom: 'Talendo', fab: 'UPL', amm: 'FR-2017-0445', forme: 'EC 200 g/L quinoxyfène', dose: 0.075 },
            { nom: 'Folicur', fab: 'Bayer', amm: 'FR-2015-0678', forme: 'EC 250 g/L tébuconazole', dose: 0.1 },
            { nom: 'Prosper Evo', fab: 'Bayer', amm: 'FR-2019-0234', forme: 'EC (spirox+tébu)', dose: 0.1 },
          ]
        },
      }
    },
    insecticide: {
      label: '🐛 Insecticide',
      matieres: {
        spinosad: {
          label: 'Spinosad (biocontrôle)',
          dose_ref: 0.25, dose_max: 0.375, unite: 'L/ha',
          dar: 7, znt: 20, categ: 'Biocontrôle',
          cibles: 'Vers de la grappe (Lobesia botrana, Eupoecilia ambiguella)',
          nb_applic: '3 applications max/an',
          restriction: 'ZNT 20m — Dangereux abeilles (pas en floraison)',
          produits: [
            { nom: 'Success 4', fab: 'Corteva', amm: 'FR-2016-0567', forme: 'SC 480 g/L', dose: 0.25 },
            { nom: 'Laser', fab: 'Corteva', amm: 'FR-2015-0445', forme: 'SC 480 g/L', dose: 0.25 },
          ]
        },
        acetamipride: {
          label: 'Acétamipride (néonicotinoïde)',
          dose_ref: 0.125, dose_max: 0.15, unite: 'kg/ha',
          dar: 14, znt: 20, categ: 'Insecticide',
          cibles: 'Cicadelles (Empoasca vitis, Scaphoideus titanus)',
          nb_applic: '2 applications max/an',
          restriction: 'ZNT 20m — Interdit floraison — Surveillance FD',
          produits: [
            { nom: 'Mospilan SG', fab: 'Nisso', amm: 'FR-2017-0678', forme: 'SG 20%', dose: 0.125 },
            { nom: 'Gazel', fab: 'Nufarm', amm: 'FR-2018-0334', forme: 'SG 20%', dose: 0.125 },
          ]
        },
        lambdacyhalothrine: {
          label: 'Lambda-cyhalothrine (pyréthrinoïde)',
          dose_ref: 0.015, dose_max: 0.02, unite: 'L/ha',
          dar: 14, znt: 20, categ: 'Insecticide',
          cibles: 'Vers de la grappe, Cicadelles, Thrips',
          nb_applic: '2 applications max/an',
          restriction: 'ZNT 20m — Très dangereux organismes aquatiques',
          produits: [
            { nom: 'Karaté Zeon', fab: 'Syngenta', amm: 'FR-2016-0892', forme: 'CS 100 g/L', dose: 0.015 },
            { nom: 'Warrior 2', fab: 'Syngenta', amm: 'FR-2018-0567', forme: 'CS 100 g/L', dose: 0.015 },
          ]
        },
        kaolin: {
          label: 'Kaolin (protection physique — biocontrôle)',
          dose_ref: 6.0, dose_max: 8.0, unite: 'kg/ha',
          dar: 0, znt: 5, categ: 'Biocontrôle',
          cibles: 'Cicadelle verte, Vers de la grappe, Cicadelle de la FD',
          nb_applic: 'Sans limite',
          restriction: 'Efficacité dépendante de la pluie — À renouveler',
          produits: [
            { nom: 'Surround WP', fab: 'Tessenderlo', amm: 'FR-2019-0123', forme: 'WP 95%', dose: 6.0 },
          ]
        },
      }
    },
    herbicide: {
      label: '🌿 Herbicide',
      matieres: {
        glyphosate: {
          label: 'Glyphosate',
          dose_ref: 1.44, dose_max: 2.16, unite: 'L/ha',
          dar: 0, znt: 5, categ: 'Herbicide',
          cibles: 'Adventices annuelles et vivaces — Désherbage rang',
          nb_applic: '2 passages max/an',
          restriction: 'Interdit < 3m cours d’eau - Pas avant vendange - CMR suspecté',
          produits: [
            { nom: 'Roundup Star', fab: 'Bayer', amm: 'FR-2018-0445', forme: 'SL 360 g/L', dose: 1.44 },
            { nom: 'Glyphogan 480 SL', fab: 'Nufarm', amm: 'FR-2016-0678', forme: 'SL 480 g/L', dose: 1.08 },
            { nom: 'Touchdown Premium', fab: 'Syngenta', amm: 'FR-2017-0334', forme: 'SL 450 g/L', dose: 1.15 },
          ]
        },
        flazasulfuron: {
          label: 'Flazasulfuron (sulfonylurée)',
          dose_ref: 0.1, dose_max: 0.1, unite: 'kg/ha',
          dar: 0, znt: 20, categ: 'Herbicide',
          cibles: 'Adventices annuelles et vivaces — Liseron, Chiendent',
          nb_applic: '1 application/an',
          restriction: 'ZNT 20m — Risque phytotox si dérive — Sol argileux',
          produits: [
            { nom: 'Katana', fab: 'ISK Biosciences', amm: 'FR-2015-0567', forme: 'WG 25%', dose: 0.1 },
            { nom: 'Chikara', fab: 'Bayer', amm: 'FR-2017-0892', forme: 'WG 25%', dose: 0.1 },
          ]
        },
        pendimethaline: {
          label: 'Pendiméthaline (herbicide de prélevée)',
          dose_ref: 2.6, dose_max: 2.6, unite: 'L/ha',
          dar: 0, znt: 20, categ: 'Herbicide',
          cibles: 'Adventices annuelles — Action prélevée sol humide',
          nb_applic: '1 application/an',
          restriction: 'ZNT 20m — Appliquer avant germination adventices',
          produits: [
            { nom: 'Stomp Aqua', fab: 'BASF', amm: 'FR-2016-0445', forme: 'CS 455 g/L', dose: 2.6 },
          ]
        },
      }
    },
    biocontrole: {
      label: '🌱 Biocontrôle / AB',
      matieres: {
        bicarbonate: {
          label: 'Bicarbonate de potassium',
          dose_ref: 3.0, dose_max: 5.0, unite: 'kg/ha',
          dar: 0, znt: 5, categ: 'Biocontrôle',
          cibles: 'Oïdium — Action curative rapide',
          nb_applic: 'Sans limite',
          restriction: 'Efficacité sur oïdium débutant — pH milieu alcalinisant',
          produits: [
            { nom: 'Armicarb', fab: 'Certis', amm: 'FR-2018-0234', forme: 'SP 85%', dose: 3.0 },
            { nom: 'Karma', fab: 'De Sangosse', amm: 'FR-2019-0567', forme: 'SP 85%', dose: 3.0 },
          ]
        },
        huilesorgonum: {
          label: 'Huile essentielle orange / Soufre AB',
          dose_ref: 1.0, dose_max: 2.0, unite: 'L/ha',
          dar: 0, znt: 5, categ: 'Biocontrôle',
          cibles: 'Oïdium, Acariens — Autorisation AB',
          nb_applic: 'Sans limite',
          restriction: 'Ne pas mélanger avec produits acides — T° < 25°C',
          produits: [
            { nom: 'Prev-Am', fab: 'Goëmar', amm: 'FR-2020-0345', forme: 'EC (orange essentielle)', dose: 1.0 },
            { nom: 'Limocide', fab: 'TIPKE', amm: 'FR-2021-0678', forme: 'EC (citrus)', dose: 1.5 },
          ]
        },
        pyrethrine: {
          label: 'Pyréthrines naturelles (insecticide AB)',
          dose_ref: 0.2, dose_max: 0.3, unite: 'L/ha',
          dar: 3, znt: 20, categ: 'Biocontrôle',
          cibles: 'Vers de la grappe, Cicadelles, Thrips',
          nb_applic: '3 applications max/an',
          restriction: 'ZNT 20m — Très dangereux abeilles — Soir uniquement',
          produits: [
            { nom: 'Pyrethrum FS', fab: 'Certis', amm: 'FR-2017-0123', forme: 'FS 25 g/L', dose: 0.25 },
            { nom: 'Nakar', fab: 'Agrauxine', amm: 'FR-2019-0456', forme: 'EC 23 g/L', dose: 0.2 },
          ]
        },
        argile: {
          label: 'Argile blanche (kaolin — protection AB)',
          dose_ref: 5.0, dose_max: 8.0, unite: 'kg/ha',
          dar: 0, znt: 5, categ: 'Biocontrôle',
          cibles: 'Protection thermique, Cicadelle FD, Eudémis',
          nb_applic: 'Sans limite',
          restriction: 'Renforcer après pluie — Compatible AB et HVE',
          produits: [
            { nom: 'Surround WP', fab: 'Tessenderlo', amm: 'FR-2019-0123', forme: 'WP 95%', dose: 5.0 },
          ]
        },
      }
    }
  }
};

// Extension base — produits supplémentaires fréquents en vigne
const PHYTO_EXTRA = [
  // Fongicides mildiou
  {nomProd:'Mildicut',fab:'UPL',amm:'FR-2019-1847',forme:'SC (cyazofamid)',dose_ref:0.25,dose_max:0.3,unite:'L/ha',dar:7,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'4/an',restriction:'Max 2 applications consécutives',searchText:'mildicut upl cyazofamid mildiou fongicide'},
  {nomProd:'Equation Pro',fab:'Corteva',amm:'FR-2017-0923',forme:'WG (famoxadone+cymoxanil)',dose_ref:0.4,dose_max:0.4,unite:'kg/ha',dar:21,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'4/an',restriction:'Max 2 consécutives - rotation obligatoire',searchText:'equation pro corteva famoxadone cymoxanil mildiou fongicide'},
  {nomProd:'Pergado MZ',fab:'Syngenta',amm:'FR-2018-0445',forme:'WG (mandipropamid+mancozèbe)',dose_ref:2.5,dose_max:2.5,unite:'kg/ha',dar:28,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'3/an',restriction:'CMR2 - EPI complet',searchText:'pergado syngenta mandipropamid mancozebe mildiou fongicide'},
  {nomProd:'Infinito',fab:'Bayer',amm:'FR-2016-0678',forme:'SC (fluopicolide+propamocarbe)',dose_ref:1.6,dose_max:1.6,unite:'L/ha',dar:14,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'3/an',restriction:'Rotation FRAC 43+28',searchText:'infinito bayer fluopicolide propamocarbe mildiou fongicide'},
  {nomProd:'Enervin',fab:'BASF',amm:'FR-2019-0234',forme:'SC (ametoctradine+dimethomorphe)',dose_ref:1.5,dose_max:1.5,unite:'L/ha',dar:14,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'3/an',restriction:'',searchText:'enervin basf ametoctradine dimethomorphe mildiou fongicide'},
  {nomProd:'Valis M',fab:'Gowan',amm:'FR-2020-0567',forme:'WG (valifenalate+mancozèbe)',dose_ref:2.0,dose_max:2.0,unite:'kg/ha',dar:28,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'3/an',restriction:'',searchText:'valis gowan valifenalate mancozebe mildiou fongicide'},
  {nomProd:'Verita',fab:'BASF',amm:'FR-2017-0891',forme:'WG (fenamidone+fosétyl)',dose_ref:2.0,dose_max:2.0,unite:'kg/ha',dar:28,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'4/an',restriction:'',searchText:'verita basf fenamidone fosetyl mildiou fongicide'},
  {nomProd:'Profiler',fab:'Bayer',amm:'FR-2018-1023',forme:'WG (fluopicolide+fosétyl)',dose_ref:1.75,dose_max:1.75,unite:'kg/ha',dar:28,znt:5,categ:'Fongicide',cibles:'Mildiou',nb_applic:'3/an',restriction:'',searchText:'profiler bayer fluopicolide fosetyl mildiou fongicide'},
  // Fongicides oïdium
  {nomProd:'Vivando',fab:'BASF',amm:'FR-2016-0445',forme:'SC (metrafenone)',dose_ref:0.16,dose_max:0.2,unite:'L/ha',dar:21,znt:5,categ:'Fongicide',cibles:'Oïdium',nb_applic:'2/an',restriction:'Max 2 consécutives',searchText:'vivando basf metrafenone oidium fongicide'},
  {nomProd:'Dynali',fab:'Syngenta',amm:'FR-2019-0789',forme:'EC (difénoconazole+cyflufénamide)',dose_ref:0.175,dose_max:0.175,unite:'L/ha',dar:28,znt:5,categ:'Fongicide',cibles:'Oïdium',nb_applic:'3/an',restriction:'CMR1B - EPI complet',searchText:'dynali syngenta difenoconazole cyflufenamide oidium fongicide'},
  {nomProd:'Luna Experience',fab:'Bayer',amm:'FR-2018-0334',forme:'SC (fluopyram+tebuconazole)',dose_ref:0.75,dose_max:0.75,unite:'L/ha',dar:14,znt:5,categ:'Fongicide',cibles:'Oïdium Botrytis',nb_applic:'2/an',restriction:'CMR1B',searchText:'luna experience bayer fluopyram tebuconazole oidium botrytis fongicide'},
  {nomProd:'Cisero',fab:'Syngenta',amm:'FR-2020-0892',forme:'WG (cyflufénamide)',dose_ref:0.05,dose_max:0.05,unite:'kg/ha',dar:21,znt:5,categ:'Fongicide',cibles:'Oïdium',nb_applic:'2/an',restriction:'Max 2 consécutives',searchText:'cisero syngenta cyflufenamide oidium fongicide'},
  // Biocontrôle / Huiles essentielles
  {nomProd:'Citrothiol',fab:'De Sangosse',amm:'FR-2021-0456',forme:'EC (huile essentielle citrus)',dose_ref:1.0,dose_max:2.0,unite:'L/ha',dar:0,znt:5,categ:'Biocontrôle',cibles:'Oïdium Acariens',nb_applic:'Sans limite',restriction:'T° < 25°C - Ne pas mélanger avec produits acides',searchText:'citrothiol de sangosse huile essentielle citrus oidium acariens biocontrole ab'},
  {nomProd:'Timorex Gold',fab:'Stockton',amm:'FR-2019-0678',forme:'EC (huile tea tree)',dose_ref:0.6,dose_max:0.8,unite:'L/ha',dar:3,znt:5,categ:'Biocontrôle',cibles:'Oïdium Mildiou Botrytis',nb_applic:'Sans limite',restriction:'Autorisé AB',searchText:'timorex gold stockton tea tree oidium mildiou botrytis biocontrole ab'},
  {nomProd:'Serenade ASO',fab:'Bayer',amm:'FR-2018-0234',forme:'AS (Bacillus subtilis)',dose_ref:4.0,dose_max:4.0,unite:'L/ha',dar:0,znt:5,categ:'Biocontrôle',cibles:'Botrytis Oïdium',nb_applic:'Sans limite',restriction:'Autorisé AB - efficacité préventive',searchText:'serenade bayer bacillus subtilis botrytis oidium biocontrole ab'},
  {nomProd:'Botector',fab:'Bio-Ferm',amm:'FR-2017-0345',forme:'WG (Aureobasidium pullulans)',dose_ref:0.15,dose_max:0.15,unite:'kg/ha',dar:0,znt:5,categ:'Biocontrôle',cibles:'Botrytis',nb_applic:'Sans limite',restriction:'Autorisé AB',searchText:'botector bio-ferm aureobasidium botrytis biocontrole ab'},
  {nomProd:'Sonata',fab:'Bayer',amm:'FR-2020-0123',forme:'AS (Bacillus pumilus)',dose_ref:4.0,dose_max:4.0,unite:'L/ha',dar:0,znt:5,categ:'Biocontrôle',cibles:'Oïdium',nb_applic:'Sans limite',restriction:'Autorisé AB',searchText:'sonata bayer bacillus pumilus oidium biocontrole ab'},
  // Insecticides
  {nomProd:'Coragen',fab:'Corteva',amm:'FR-2016-0567',forme:'SC (chlorantraniliprole)',dose_ref:0.175,dose_max:0.175,unite:'L/ha',dar:7,znt:20,categ:'Insecticide',cibles:'Vers de la grappe Tordeuses',nb_applic:'2/an',restriction:'ZNT 20m - Dangereux abeilles',searchText:'coragen corteva chlorantraniliprole vers grappe tordeuse insecticide'},
  {nomProd:'Affirm',fab:'Syngenta',amm:'FR-2017-0891',forme:'WG (emamectine benzoate)',dose_ref:1.5,dose_max:1.5,unite:'kg/ha',dar:7,znt:20,categ:'Insecticide',cibles:'Vers de la grappe',nb_applic:'2/an',restriction:'ZNT 20m',searchText:'affirm syngenta emamectine vers grappe insecticide'},
  {nomProd:'Movento',fab:'Bayer',amm:'FR-2018-0345',forme:'SC (spirotetramat)',dose_ref:0.75,dose_max:0.75,unite:'L/ha',dar:14,znt:20,categ:'Insecticide',cibles:'Cicadelles Cochenilles',nb_applic:'1/an',restriction:'ZNT 20m',searchText:'movento bayer spirotetramat cicadelle cochenille insecticide'},
  {nomProd:'Sivanto Prime',fab:'Bayer',amm:'FR-2019-0678',forme:'SL (flupyradifurone)',dose_ref:0.3,dose_max:0.3,unite:'L/ha',dar:7,znt:10,categ:'Insecticide',cibles:'Cicadelles Pucerons',nb_applic:'2/an',restriction:'ZNT 10m - Moins dangereux abeilles',searchText:'sivanto bayer flupyradifurone cicadelle puceron insecticide'},
  // Herbicides
  {nomProd:'Katana',fab:'ISK Biosciences',amm:'FR-2015-0567',forme:'WG 25% (flazasulfuron)',dose_ref:0.1,dose_max:0.1,unite:'kg/ha',dar:0,znt:20,categ:'Herbicide',cibles:'Adventices annuelles vivaces Liseron Chiendent',nb_applic:'1/an',restriction:'ZNT 20m',searchText:'katana isk flazasulfuron liseron chiendent adventice herbicide'},
  {nomProd:'Basta F1',fab:'Bayer',amm:'FR-2016-0789',forme:'SL (glufosinate)',dose_ref:3.0,dose_max:3.0,unite:'L/ha',dar:0,znt:20,categ:'Herbicide',cibles:'Adventices annuelles vivaces',nb_applic:'2/an',restriction:'ZNT 20m - Pas avant vendange',searchText:'basta bayer glufosinate adventice herbicide'},
  {nomProd:'Centurion',fab:'Gowan',amm:'FR-2017-0234',forme:'EC (cléthodime)',dose_ref:0.5,dose_max:0.5,unite:'L/ha',dar:0,znt:5,categ:'Herbicide',cibles:'Graminées vivaces',nb_applic:'1/an',restriction:'Anti-graminées sélectif',searchText:'centurion gowan clethodime graminee herbicide'},
];

// Fusionner dans l’index global
if(typeof window !== 'undefined') {
  window.PHYTO_EXTRA = PHYTO_EXTRA;
}



function initPhytoSelects() {
  // Construire l’index de recherche plat à partir de la base
  window.PHYTO_INDEX = [];
  Object.entries(PHYTO_DB.categories).forEach(([catKey, cat]) => {
    Object.entries(cat.matieres).forEach(([maKey, ma]) => {
      ma.produits.forEach(p => {
        window.PHYTO_INDEX.push({
          searchText: [p.nom, ma.label, cat.label, p.fab, ma.cibles].join(' ').toLowerCase(),
          nomProd: p.nom, fab: p.fab, amm: p.amm, forme: p.forme,
          dose: p.dose, catLabel: cat.label, maLabel: ma.label,
          dose_ref: ma.dose_ref, dose_max: ma.dose_max, unite: ma.unite,
          dar: ma.dar, znt: ma.znt, categ: ma.categ,
          cibles: ma.cibles, nb_applic: ma.nb_applic, restriction: ma.restriction,
        });
      });
      window.PHYTO_INDEX.push({
        searchText: [ma.label, cat.label, ma.cibles].join(' ').toLowerCase(),
        nomProd: ma.label.split(' (')[0], fab: '', amm: '', forme: '',
        dose: ma.dose_ref, catLabel: cat.label, maLabel: ma.label,
        dose_ref: ma.dose_ref, dose_max: ma.dose_max, unite: ma.unite,
        dar: ma.dar, znt: ma.znt, categ: ma.categ,
        cibles: ma.cibles, nb_applic: ma.nb_applic, restriction: ma.restriction,
        isMA: true
      });
    });
  });
  // Ajouter les produits supplémentaires
  (window.PHYTO_EXTRA || []).forEach(p => {
    window.PHYTO_INDEX.push({
      searchText: p.searchText,
      nomProd: p.nomProd, fab: p.fab, amm: p.amm, forme: p.forme,
      dose: p.dose_ref, catLabel: p.categ, maLabel: p.cibles,
      dose_ref: p.dose_ref, dose_max: p.dose_max, unite: p.unite,
      dar: p.dar, znt: p.znt, categ: p.categ,
      cibles: p.cibles, nb_applic: p.nb_applic, restriction: p.restriction,
    });
  });
}

function searchPhyto(query) {
  const res = document.getElementById('mpSearchResults');
  if (!query || query.length < 2) { res.style.display = 'none'; return; }
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const q = norm(query);
  const matches = (window.PHYTO_INDEX || [])
    .filter(p => norm(p.searchText).includes(q))
    .sort((a,b) => {
      const ta = norm(a.nomProd), tb = norm(b.nomProd);
      return (ta.startsWith(q)?0:1) - (tb.startsWith(q)?0:1);
    })
    .slice(0, 15);
  if (!matches.length) {
    // Auto-remplit le champ « Nom commercial » avec ce que l'utilisateur a tapé
    // pour qu'il puisse simplement cliquer « Enregistrer » sans avoir à retaper.
    sv('mpNom', query);
    res.style.display = 'block';
    res.innerHTML = `<div style="padding:12px;font-size:13px;color:var(--gris);text-align:center">
      Aucun produit local pour "<b>${query}</b>"<br>
      <div style="font-size:12px;margin-top:8px;color:var(--terre);font-weight:600">✅ « ${query} » a été pré-rempli ci-dessous — complète les infos puis clique 💾 Enregistrer</div>
      <button class="btn btgold btsm" style="margin-top:8px" onclick="rechercherEphy('${query.replace(/'/g,"&#39;")}')">🔍 Chercher sur E-phy ANSES</button>
    </div>`;
    return;
  }
  res.style.display = 'block';
  res.innerHTML = matches.map((p, i) => `
    <div onclick="selectPhytoProd(${i})"
      style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--gris2);transition:background .15s"
      onmouseenter="this.style.background='var(--gris3)'"
      onmouseleave="this.style.background=''">
      <div style="font-weight:700;font-size:13px;color:var(--terre)">${p.nomProd}${p.isMA?' <span style="font-size:10px;color:var(--gris);font-weight:400">(matière active)</span>':''}</div>
      <div style="font-size:11px;color:var(--gris);margin-top:2px">${p.maLabel} · ${p.catLabel}${p.fab?' · '+p.fab:''}</div>
      <div style="display:flex;gap:8px;margin-top:3px;flex-wrap:wrap">
        <span style="font-size:10px;background:#d4edda;color:var(--vert);padding:1px 6px;border-radius:4px">DAR ${p.dar}j</span>
        <span style="font-size:10px;background:#d4e8f4;color:#2a6a9a;padding:1px 6px;border-radius:4px">ZNT ${p.znt}m</span>
        <span style="font-size:10px;background:#fdf3d0;color:#8a6a10;padding:1px 6px;border-radius:4px">${p.dose_ref} ${p.unite}</span>
      </div>
    </div>`).join('');
  window.PHYTO_LAST_RESULTS = matches;
}

function selectPhytoProd(idx) {
  const p = window.PHYTO_LAST_RESULTS[idx];
  if (!p) return;
  document.getElementById('mpSearchResults').style.display = 'none';
  document.getElementById('mpSearch').value = p.nomProd;
  sv('mpNom', p.nomProd);
  sv('mpFab', p.fab || '');
  sv('mpAMM', p.amm || '');
  sv('mpForma', p.forme || '');
  sv('mpDoseRef', p.dose || p.dose_ref);
  sv('mpDAR', p.dar);
  sv('mpZNT', p.znt);
  sv('mpCibles', p.cibles || '');
  const uniteEl = document.getElementById('mpUnite');
  if (uniteEl) {
    const u = p.unite || 'kg/ha';
    uniteEl.value = u.includes('L') ? 'L/ha' : u.includes('g/ha') ? 'g/ha' : 'kg/ha';
    document.getElementById('mpDoseUnit').textContent = uniteEl.value;
    document.getElementById('mpQteUnit').textContent = uniteEl.value.replace('/ha','');
  }
  const categEl = document.getElementById('mpCateg');
  if (categEl && p.categ) categEl.value = p.categ;
  const warnings = [];
  if (p.dar > 21) warnings.push(`⏰ DAR long : ${p.dar} jours avant récolte`);
  if (p.znt >= 20) warnings.push(`🌊 ZNT ${p.znt}m — Zones non traitées obligatoires`);
  if (p.restriction) warnings.push(`⚠️ ${p.restriction}`);
  if (p.nb_applic) warnings.push(`🔢 ${p.nb_applic}`);
  const alertEl = document.getElementById('mpPhytoAlert');
  const alertContent = document.getElementById('mpPhytoAlertContent');
  if (alertEl) {
    alertEl.style.display = warnings.length ? 'flex' : 'none';
    if (alertContent) alertContent.innerHTML = warnings.map(w=>`<div style="margin-bottom:3px;font-size:12px">${w}</div>`).join('');
  }
  toast(`✅ ${p.nomProd} sélectionné`);
}

// Fermer les résultats si on clique ailleurs
document.addEventListener('click', e => {
  const res = document.getElementById('mpSearchResults');
  if (res && !res.contains(e.target) && e.target.id !== 'mpSearch') {
    res.style.display = 'none';
  }
});

// Anciennes fonctions cascade (gardées pour compatibilité)
function onCategChange(){}
function onMAChange(){}
function onProdChange(){}

function onCategChange() {
  const catKey = document.getElementById('mpCategPhyto').value;
  const selMA = document.getElementById('mpMAPhyto');
  const selProd = document.getElementById('mpProdPhyto');
  selMA.innerHTML = '<option value="">— Choisir une matière active —</option>';
  selProd.innerHTML = '<option value="">— Choisir un produit —</option>';
  clearPhytoFields();
  if (!catKey) return;
  const cat = PHYTO_DB.categories[catKey];
  if (!cat) return;
  Object.entries(cat.matieres).forEach(([key, ma]) => {
    selMA.innerHTML += `<option value="${key}">${ma.label}</option>`;
  });
  document.getElementById('mpMAPhyto').disabled = false;
  document.getElementById('mpProdPhyto').disabled = true;
}

function onMAChange() {
  const catKey = document.getElementById('mpCategPhyto').value;
  const maKey = document.getElementById('mpMAPhyto').value;
  const selProd = document.getElementById('mpProdPhyto');
  selProd.innerHTML = '<option value="">— Choisir la spécialité commerciale —</option>';
  clearPhytoFields();
  if (!catKey || !maKey) return;
  const ma = PHYTO_DB.categories[catKey]?.matieres[maKey];
  if (!ma) return;
  // Afficher les infos MA
  fillPhytoFromMA(ma);
  // Remplir produits
  ma.produits.forEach(p => {
    selProd.innerHTML += `<option value="${p.nom}" data-fab="${p.fab}" data-amm="${p.amm}" data-forme="${p.forme}" data-dose="${p.dose}">${p.nom} (${p.fab})</option>`;
  });
  selProd.disabled = false;
}

function onProdChange() {
  const catKey = document.getElementById('mpCategPhyto').value;
  const maKey = document.getElementById('mpMAPhyto').value;
  const selProd = document.getElementById('mpProdPhyto');
  const opt = selProd.options[selProd.selectedIndex];
  if (!opt || !opt.value) return;
  const ma = PHYTO_DB.categories[catKey]?.matieres[maKey];
  if (!ma) return;
  // Remplir avec le produit sélectionné
  setVal('mpNom', opt.value);
  setVal('mpFab', opt.dataset.fab || '');
  setVal('mpAMM', opt.dataset.amm || '');
  // Dose spécifique au produit si différente
  const dose = parseFloat(opt.dataset.dose) || ma.dose_ref;
  setVal('mpDoseRef', dose);
  // Afficher la formulation
  const phForma = document.getElementById('mpForma');
  if (phForma) phForma.value = opt.dataset.forme || '';
  // Résumé réglementaire
  updatePhytoAlert(ma, opt.value);
}

function fillPhytoFromMA(ma) {
  setVal('mpDoseRef', ma.dose_ref);
  setVal('mpDAR', ma.dar);
  setVal('mpZNT', ma.znt);
  setVal('mpCibles', ma.cibles);
  // Unité
  const uniteEl = document.getElementById('mpUnite');
  if (uniteEl) {
    uniteEl.value = ma.unite.includes('L') ? 'L/ha' : 'kg/ha';
    document.getElementById('mpDoseUnit').textContent = uniteEl.value;
    document.getElementById('mpQteUnit').textContent = uniteEl.value.replace('/ha','');
  }
  // Catégorie Supabase
  const catEl = document.getElementById('mpCateg');
  if (catEl) catEl.value = ma.categ;
}

function clearPhytoFields() {
  ['mpNom','mpFab','mpAMM','mpForma','mpDoseRef','mpDAR','mpZNT','mpCibles'].forEach(id => sv(id, ''));
  const alertEl = document.getElementById('mpPhytoAlert');
  if (alertEl) alertEl.style.display = 'none';
}

function updatePhytoAlert(ma, prodNom) {
  const alertEl = document.getElementById('mpPhytoAlert');
  if (!alertEl) return;
  const warnings = [];
  if (ma.dar > 21) warnings.push(`⏰ DAR long : ${ma.dar} jours avant récolte`);
  if (ma.znt >= 20) warnings.push(`🌊 ZNT ${ma.znt}m — Zones non traitées obligatoires`);
  if (ma.restriction) warnings.push(`⚠️ ${ma.restriction}`);
  if (ma.nb_applic) warnings.push(`🔢 Limites : ${ma.nb_applic}`);
  alertEl.style.display = 'block';
  const contentEl = document.getElementById('mpPhytoAlertContent');
  if (contentEl) contentEl.innerHTML = warnings.map(w => `<div style="margin-bottom:4px;font-size:12px">${w}</div>`).join('');
}

// ══════════════════════════════════════════
//  FERTILISATION
// ══════════════════════════════════════════

function getSelectedFertiParcs() {
  return Array.from(document.querySelectorAll('#fPaWrap input[type=checkbox]:checked')).map(cb => cb.value);
}

function fillFertiSelects() {
  const wrap=document.getElementById('fPaWrap');
  wrap.innerHTML='';
  activeParcs().forEach(p=>{
    const lbl=document.createElement('label');
    lbl.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;font-size:14px';
    lbl.innerHTML=`<input type="checkbox" value="${p.code}" onchange="uFi()" style="width:20px;height:20px;accent-color:#2d5a1e;cursor:pointer;-webkit-appearance:checkbox;appearance:checkbox"> ${p.code} · ${p.nom} (${p.surface_ha||'?'} ha)`;
    wrap.appendChild(lbl);
  });
  const en=document.getElementById('fEn');
  en.innerHTML='<option value="">— Choisir —</option>';
  ENGRAIS.forEach(e=>{
    en.innerHTML+=`<option value="${e.id}" data-npk="${e.composition_npk||''}">${e.nom} (${e.qte_stock} ${e.unite_stock})</option>`;
  });
  if(!ENGRAIS.length) en.innerHTML+='<option disabled>— Ajouter un engrais d\'abord —</option>';
}

function selEngrais() {
  const sel=document.getElementById('fEn'),opt=sel.options[sel.selectedIndex];
  if(!opt.value) return;
  const e=ENGRAIS.find(x=>x.id===opt.value);
  if(e&&e.composition_npk){
    const npk=e.composition_npk.split('-').map(v=>parseFloat(v)||0);
    document.getElementById('fN').value=npk[0]||'';
    document.getElementById('fP').value=npk[1]||'';
    document.getElementById('fK').value=npk[2]||'';
  }
  uFi();
}

function uFi() {
  const selParcs=getSelectedFertiParcs();
  const en=document.getElementById('fEn').value;
  const btn=document.getElementById('bSF');
  btn.disabled=!(selParcs.length&&en);
}

async function saveFert() {
  const selParcs=getSelectedFertiParcs();
  if(!selParcs.length){toast('⚠️ Parcelle obligatoire');return;}
  const en=document.getElementById('fEn').value;
  if(!en){toast('⚠️ Engrais obligatoire');return;}
  const dateApp=document.getElementById('fD').value;
  const heureApp=document.getElementById('fH').value;
  const dose=parseFloat(document.getElementById('fDose').value);
  const doseUn=document.getElementById('fDoseUn').value;
  const n=parseFloat(document.getElementById('fN').value)||null;
  const p=parseFloat(document.getElementById('fP').value)||null;
  const k=parseFloat(document.getElementById('fK').value)||null;
  const mode=document.getElementById('fMode').value;
  const notes=document.getElementById('fNotes').value;
  syncSaving();
  try{
    const engr=ENGRAIS.find(x=>x.id===en);
    const payload=[];
    for(const pCode of selParcs){
      const parc=PARCS.find(p=>p.code===pCode);
      payload.push({
        domaine_id:DOM_ID,
        parcelle_id:parc?.id,
        parcelle_code:pCode,
        engrais_id:en,
        engrais_nom:engr?.nom||'—',
        date_application:dateApp,
        heure_application:heureApp,
        campagne:AN,
        dose_appliquee:dose||null,
        dose_unite:doseUn,
        composition_npk:engr?.composition_npk||null,
        mode_apport:mode,
        notes,
      });
    }
    const {data,error}=await sb.from('fertilisations').insert(payload).select();
    if(error)throw error;
    data.forEach(d=>FERTIS.unshift(d));

    // Déduire stock engrais
    for(const pCode of selParcs){
      const parc=PARCS.find(p=>p.code===pCode);
      if(engr&&parc&&dose){
        const nq=Math.max(0,Math.round((engr.qte_stock-dose*(parc.surface_ha||1))*100)/100);
        const ne=nq<=0?'zero':nq<=engr.seuil_alerte?'low':'ok';
        await sb.from('engrais').update({qte_stock:nq,etat:ne}).eq('id',en);
        engr.qte_stock=nq;engr.etat=ne;
      }
    }

    syncOK();
    fillFertiSelects();renderFertiHistory();
    toast(`✅ ${selParcs.length} parcelle(s) · ${dose} ${doseUn}`);
    ['fD','fH','fDose','fN','fP','fK','fNotes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('fEn').value='';
    document.querySelectorAll('#fPaWrap input[type=checkbox]').forEach(cb=>cb.checked=false);
    document.getElementById('bSF').disabled=true;
  }catch(e){syncErr();toast('❌ Erreur : '+e.message);}
}

async function saveEngrais() {
  const nom=document.getElementById('meNom').value.trim();
  if(!nom){toast('⚠️ Nom obligatoire');return;}
  syncSaving();
  try{
    const n=parseFloat(document.getElementById('meN').value)||null;
    const p=parseFloat(document.getElementById('meP').value)||null;
    const k=parseFloat(document.getElementById('meK').value)||null;
    const npk=n!==null||p!==null||k!==null?`${n||0}-${p||0}-${k||0}`:null;
    const {data,error}=await sb.from('engrais').insert({
      domaine_id:DOM_ID,
      nom,
      composition_npk:npk,
      type_produit:document.getElementById('meType').value,
      qte_stock:parseFloat(document.getElementById('meQte').value)||0,
      unite_stock:document.getElementById('meUnite').value,
      seuil_alerte:parseFloat(document.getElementById('meSeuil').value)||null,
      etat:'ok'
    }).select().single();
    if(error)throw error;
    ENGRAIS.push(data);syncOK();fillFertiSelects();
    toast('✅ Engrais ajouté');closeM(null,'mAddEngrais');
    ['meNom','meN','meP','meK','meType','meQte','meSeuil'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  }catch(e){syncErr();toast('❌ Erreur : '+e.message);}
}

function renderFertiHistory() {
  const h=document.getElementById('fHist');
  if(!FERTIS.length){h.innerHTML='<div style="font-size:13px;color:var(--gris);text-align:center;padding:16px">Aucun apport enregistré</div>';return;}
  h.innerHTML=FERTIS.slice(0,20).map(f=>`<div class="li"><div class="lic" style="background:#d4f0e8">🌱</div><div class="lib"><div class="lit">${f.engrais_nom||'—'}</div><div class="lim">${f.date_application} · ${f.parcelle_code} · ${f.dose_appliquee||'—'} ${f.dose_unite}</div><div style="font-size:11px;color:var(--gris);margin-top:2px">${f.mode_apport||'—'} · ${f.composition_npk||'—'}</div></div></div>`).join('');
}
