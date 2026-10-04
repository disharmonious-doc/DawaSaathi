const state = {
  rxBlob: null,
  medBlob: null,
  rxMeds: [],
  rxAdviceHindi: [],
  history: [],
  currentSpeech: ''
};

const $ = (id) => document.getElementById(id);
const rxInputs = [$('rxCameraInput'), $('rxFileInput')];
const medInputs = [$('medCameraInput'), $('medFileInput')];

function setHidden(el, yes) { if (el) el.classList.toggle('hidden', !!yes); }
function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function normalizeText(s='') { return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\u0900-\u097f]+/g,' ').trim(); }
function displayNumber(s='') { return String(s); }
function hasDevanagari(s='') { return /[\u0900-\u097f]/.test(String(s)); }
function safeHindiName(s='') { return hasDevanagari(s) ? String(s).trim() : ''; }

const hindiNumbers = {
  0:'शून्य',1:'एक',2:'दो',3:'तीन',4:'चार',5:'पाँच',6:'छह',7:'सात',8:'आठ',9:'नौ',10:'दस',
  11:'ग्यारह',12:'बारह',13:'तेरह',14:'चौदह',15:'पंद्रह',16:'सोलह',17:'सत्रह',18:'अठारह',19:'उन्नीस',20:'बीस',
  21:'इक्कीस',22:'बाईस',23:'तेईस',24:'चौबीस',25:'पच्चीस',26:'छब्बीस',27:'सत्ताईस',28:'अट्ठाईस',29:'उनतीस',30:'तीस',31:'इकतीस'
};
function numberWord(n){ return String(n); }

function stripDosageFormPrefix(s='') {
  return String(s).replace(/^\s*(rx\s*)?(tab(let)?|t\.?|cap(sule)?|syp|syr(up)?|inj(ection)?|cream|oint(ment)?|gel|drop(s)?|inhaler|neb|spray)\.?\s*/i,'').trim();
}
function normalizeDrugName(s='') {
  let n=normalizeText(stripDosageFormPrefix(s))
    .replace(/\b(tab|tablet|cap|capsule|syrup|syp|inj|injection|cream|ointment|gel|drops|drop|mg|mcg|g|ml|iu)\b/g,' ')
    .replace(/\s+/g,' ').trim();
  // Project mapping key: MV = multivitamin, BC = B complex.
  if(n==='mv') n='multivitamin';
  if(n==='bc') n='b complex';
  return n;
}

// Canonical active-moiety aliases used ONLY for generic ingredient matching.
// Keep this conservative: add an alias only when it represents the same active drug identity.
// Dose, strength, release type and formulation are checked separately.
const GENERIC_EQUIVALENTS = new Map([
  ['amoxycillin','amoxicillin'],
  ['amoxicillin trihydrate','amoxicillin'],
  ['amoxycillin trihydrate','amoxicillin'],
  ['amoxicillin sodium','amoxicillin'],
  ['amoxycillin sodium','amoxicillin'],
  ['clavulanic acid','clavulanic acid'],
  ['clavulanate','clavulanic acid'],
  ['clavulanate potassium','clavulanic acid'],
  ['potassium clavulanate','clavulanic acid'],
  ['potassium clavulanic acid','clavulanic acid'],
  ['acetaminophen','paracetamol'],
  ['paracetamol','paracetamol'],
  ['albuterol','salbutamol'],
  ['salbutamol','salbutamol']
]);

function canonicalIngredientName(value=''){
  let n=normalizeDrugName(value)
    .replace(/\b(equivalent to|equiv to|eq to)\b/g,' ')
    .replace(/\s+/g,' ')
    .trim();

  if(GENERIC_EQUIVALENTS.has(n)) return GENERIC_EQUIVALENTS.get(n);

  // Normalize a few safe presentation variants before alias lookup.
  n=n
    .replace(/\bamoxycillin\b/g,'amoxicillin')
    .replace(/\bpotassium clavulanate\b/g,'clavulanic acid')
    .replace(/\bclavulanate potassium\b/g,'clavulanic acid')
    .replace(/\bclavulanate\b/g,'clavulanic acid')
    .replace(/\s+/g,' ')
    .trim();

  return GENERIC_EQUIVALENTS.get(n) || n;
}
function levenshtein(a,b){
  a=normalizeDrugName(a); b=normalizeDrugName(b);
  if(!a.length) return b.length; if(!b.length) return a.length;
  const prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const cur=[i];
    for(let j=1;j<=b.length;j++) cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    for(let j=0;j<cur.length;j++) prev[j]=cur[j];
  }
  return prev[b.length];
}
function nameSimilarity(a,b){
  const na=normalizeDrugName(a), nb=normalizeDrugName(b);
  if(!na||!nb) return 0;
  if(na===nb) return 1;
  if(na.includes(nb)||nb.includes(na)) return Math.min(.96, Math.min(na.length,nb.length)/Math.max(na.length,nb.length)+.25);
  const ta=new Set(na.split(' ').filter(x=>x.length>2));
  const tb=new Set(nb.split(' ').filter(x=>x.length>2));
  const inter=[...ta].filter(x=>tb.has(x)).length;
  const union=new Set([...ta,...tb]).size || 1;
  const jacc=inter/union;
  const lev=1-levenshtein(na,nb)/Math.max(na.length,nb.length);
  return Math.max(jacc,lev*.85);
}

function parseStrength(text=''){
  const t=String(text).replace(/µg/gi,'mcg').replace(/μg/gi,'mcg');
  const m=t.match(/\b(\d+(?:\.\d+)?)\s*(mcg|mg|g|kg|ml|mL|l|iu|i\.u\.|units?)\b/i);
  if(!m) return null;
  return {value:parseFloat(m[1]),unit:m[2].toLowerCase().replace('i.u.','iu').replace(/^unit(s)?$/,'iu'),raw:`${m[1]} ${m[2]}`};
}
function comparableStrength(a,b){
  if(!a||!b) return null;
  const mass={mcg:.001,mg:1,g:1000,kg:1000000};
  if(mass[a.unit] && mass[b.unit]) return (a.value*mass[a.unit])/(b.value*mass[b.unit]);
  if(a.unit===b.unit) return a.value/b.value;
  return null;
}
function strengthHindi(text=''){
  if(!text) return '';
  return displayNumber(String(text)
    .replace(/mcg/gi,' माइक्रोग्राम')
    .replace(/mg/gi,' मिलीग्राम')
    .replace(/\bml\b/gi,' मिलीलीटर')
    .replace(/\bg\b/gi,' ग्राम')
    .replace(/\biu\b/gi,' अंतरराष्ट्रीय इकाई')
    .replace(/\bunits?\b/gi,' इकाई')
    .replace(/tablets?/gi,' गोली')
    .replace(/capsules?/gi,' कैप्सूल')
    .replace(/drops?/gi,' बूँद')
    .replace(/puffs?/gi,' पफ'))
    .replace(/\s+/g,' ').trim();
}

function frequencyHindi(freq=''){
  const raw=String(freq).toUpperCase().trim().replace(/\s+/g,' ');
  const f=raw.replace(/\s/g,'');
  const map={
    ODBBF:'दिन में एक बार, सुबह खाली पेट',
    ODHS:'दिन में एक बार, रात को सोने से पहले',
    OD:'दिन में एक बार',QD:'दिन में एक बार',
    BD:'दिन में दो बार',BID:'दिन में दो बार',
    TDS:'दिन में तीन बार',TID:'दिन में तीन बार',
    QID:'दिन में चार बार',QDS:'दिन में चार बार',
    ABF:'नाश्ते के बाद',BL:'दोपहर के खाने से पहले',AL:'दोपहर के खाने के बाद',AD:'रात के खाने के बाद',
    HS:'रात को सोने से पहले',SOS:'ज़रूरत पड़ने पर',PRN:'ज़रूरत पड़ने पर',STAT:'अभी एक बार',
    '1-0-1':'सुबह और रात','1-1-1':'सुबह, दोपहर और रात','1-0-0':'सुबह','0-1-0':'दोपहर','0-0-1':'रात'
  };
  if(map[f]) return map[f];
  if(/once\s*(daily|a day)/i.test(freq)) return 'दिन में एक बार';
  if(/twice\s*(daily|a day)/i.test(freq)) return 'दिन में दो बार';
  if(/three\s*times|thrice/i.test(freq)) return 'दिन में तीन बार';
  return freq ? 'पर्ची में लिखे समय के अनुसार' : '';
}

function volumeDoseHindi(text='', voice=false){
  const m=String(text).match(/\b(\d+(?:\.\d+)?)\s*ml\b/i);
  if(!m) return '';
  const n=Number(m[1]);
  const amount=(voice && Number.isInteger(n)) ? numberWord(n) : displayNumber(m[1]);
  let approx='';
  if(n===5) approx=' यानी लगभग एक छोटा चम्मच';
  if(n===15) approx=' यानी लगभग एक बड़ा चम्मच';
  return `${amount} मिलीलीटर${approx}`;
}
function routeHindi(route=''){
  const r=String(route).toLowerCase();
  if(/oral|po|mouth/.test(r)) return 'मुँह से';
  if(/intravenous|\biv\b/.test(r)) return 'नस में';
  if(/intramuscular|\bim\b/.test(r)) return 'मांसपेशी में';
  if(/subcutaneous|\bsc\b|s\/c/.test(r)) return 'त्वचा के नीचे';
  if(/sublingual|\bsl\b/.test(r)) return 'जीभ के नीचे';
  if(/topical|apply|locally/.test(r)) return 'त्वचा पर लगाकर';
  if(/inhale|inhalation|puff|neb/.test(r)) return 'साँस के रास्ते';
  if(/eye|ophthalmic/.test(r)) return 'आँख में';
  if(/ear|otic/.test(r)) return 'कान में';
  return '';
}

function routeInstructionHindi(route=''){
  const r=String(route).toLowerCase();
  if(/oral|po|mouth/.test(r)) return '';
  if(/topical|apply|locally/.test(r)) return 'इसे त्वचा पर लगाएँ';
  if(/inhale|inhalation|puff|neb/.test(r)) return 'इसे साँस के रास्ते लें';
  if(/eye|ophthalmic/.test(r)) return 'इसे आँख में डालें';
  if(/ear|otic/.test(r)) return 'इसे कान में डालें';
  if(/sublingual|\bsl\b/.test(r)) return 'इसे जीभ के नीचे रखें';
  if(/intravenous|\biv\b|intramuscular|\bim\b|subcutaneous|\bsc\b|s\/c/.test(r)) return 'यह दवा इंजेक्शन से दी जाती है; डॉक्टर या स्वास्थ्यकर्मी के निर्देश के अनुसार लें';
  return '';
}

function durationHindi(d=''){
  const s=String(d).trim(); if(!s) return '';
  let m=s.match(/(\d+)\s*(day|days|d)\b/i); if(m) return `${displayNumber(m[1])} दिन`;
  m=s.match(/(\d+)\s*(week|weeks|wk|wks)\b/i); if(m) return `${displayNumber(m[1])} सप्ताह`;
  m=s.match(/(\d+)\s*(month|months|mo|mos)\b/i); if(m) return `${displayNumber(m[1])} महीने`;
  if(/continue|cont\.?/i.test(s)) return 'डॉक्टर के कहे अनुसार जारी रखें';
  return 'पर्ची में लिखी अवधि के अनुसार';
}
function durationVoice(d=''){
  const s=String(d).trim(); if(!s) return '';
  let m=s.match(/(\d+)\s*(day|days|d)\b/i); if(m) return `${numberWord(m[1])} दिन`;
  m=s.match(/(\d+)\s*(week|weeks|wk|wks)\b/i); if(m) return `${numberWord(m[1])} सप्ताह`;
  m=s.match(/(\d+)\s*(month|months|mo|mos)\b/i); if(m) return `${numberWord(m[1])} महीने`;
  if(/continue|cont\.?/i.test(s)) return 'डॉक्टर के कहे अनुसार';
  return '';
}
function normalizeReleaseType(text=''){
  const t=String(text||'').trim();
  const code=t.match(/\b(SR|ER|XR|CR|MR|PR|XL|LA)\b/i);
  if(code) return code[1].toUpperCase();
  if(/sustained\s*release/i.test(t)) return 'SR';
  if(/extended\s*release/i.test(t)) return 'ER';
  if(/controlled\s*release/i.test(t)) return 'CR';
  if(/modified\s*release/i.test(t)) return 'MR';
  if(/prolonged\s*release/i.test(t)) return 'PR';
  if(/long[ -]?acting/i.test(t)) return 'LA';
  return '';
}
function formHindi(form=''){
  const f=String(form).toLowerCase();
  if(/tablet|tab/.test(f)) return 'गोली';
  if(/capsule|cap/.test(f)) return 'कैप्सूल';
  if(/syrup|solution|suspension/.test(f)) return 'तरल दवा';
  if(/drop/.test(f)) return 'बूँद';
  if(/inhaler|puff/.test(f)) return 'पफ';
  if(/cream|ointment|gel/.test(f)) return 'लगाने की दवा';
  if(/injection|inj/.test(f)) return 'इंजेक्शन';
  return 'इकाई';
}
function unitHindi(form='', count=1){
  const f=formHindi(form);
  if(f==='गोली') return count===1?'गोली':'गोलियाँ';
  if(f==='कैप्सूल') return 'कैप्सूल';
  if(f==='बूँद') return count===1?'बूँद':'बूँदें';
  if(f==='पफ') return 'पफ';
  if(f==='इकाई') return count===1?'इकाई':'इकाइयाँ';
  return f;
}

function prescriptionVisionToParsed(v={}){
  const meds=(Array.isArray(v.medications)?v.medications:[]).map(m=>{
    const genericIngredients=(Array.isArray(m.generic_ingredients)?m.generic_ingredients:[])
      .map(x=>({
        name:String(x?.name||'').trim(),
        canonicalName:canonicalIngredientName(x?.name||''),
        nameHindi:safeHindiName(x?.name_hindi||''),
        confidence:Number(x?.confidence||0)
      }))
      .filter(x=>x.name);
    return {
      prescribedName:String(m.prescribed_name||'').trim(),
      genericName:String(m.generic_name||'').trim(),
      genericNameHindi:safeHindiName(m.generic_name_hindi||''),
      genericIngredients,
      genericMappingConfidence:Number(m.generic_mapping_confidence||0),
      name:String(m.generic_name||m.prescribed_name||'').trim(),
      nameHindi:safeHindiName(m.generic_name_hindi||''),
      dose:String(m.dose||'').trim(),
      frequency:String(m.frequency||'').trim(),
      route:String(m.route||'').trim(),
      duration:String(m.duration||'').trim(),
      instructions:String(m.instructions||'').trim(),
      instructionsHindi:hasDevanagari(m.instructions_hindi||'')?String(m.instructions_hindi||'').trim():'',
      confidence:Number(m.confidence||0),
      uncertainty:String(m.uncertainty||'').trim(),
      sourceLine:[m.prescribed_name,m.generic_name,m.dose,m.frequency,m.route,m.duration,m.instructions].filter(Boolean).join(' | ')
    };
  }).filter(m=>m.prescribedName || m.genericName);
  const adviceHindi=Array.isArray(v.other_instructions_hindi)?v.other_instructions_hindi.filter(x=>x&&hasDevanagari(x)):[];
  return {meds, adviceHindi};
}
function medicineVisionToPack(v={}){
  const ingredients=(Array.isArray(v.active_ingredients)?v.active_ingredients:[])
    .map(x=>({
      name:String(x?.name||'').trim(),
      canonicalName:canonicalIngredientName(x?.name||''),
      nameHindi:safeHindiName(x?.name_hindi||''),
      strength:String(x?.strength||'').trim(),
      confidence:Number(x?.confidence||0)
    }))
    .filter(x=>x.name);
  const primary=ingredients[0]||{};
  const displayName=String(v.display_name||v.brand_name||primary.name||'').trim();
  const displayHindi=safeHindiName(v.display_name_hindi||primary.name_hindi||'');
  const strengthText=String(v.strength_text||primary.strength||'').trim();
  const looksConcentrated=/\/\s*\d|\/\s*(?:m?l|g)\b|\bper\s+\d/i.test(strengthText);
  return {
    name:displayName,
    nameHindi:displayHindi,
    brandName:String(v.brand_name||'').trim(),
    strength:strengthText,
    strengthObj:looksConcentrated?null:parseStrength(strengthText),
    modified:normalizeReleaseType(v.release_type||''),
    form:String(v.dosage_form||'').trim(),
    raw:String(v.raw_transcription||'').trim(),
    ingredients,
    complex:ingredients.length>1,
    overallConfidence:Number(v.overall_confidence||0),
    uncertainties:Array.isArray(v.uncertainties)?v.uncertainties.filter(Boolean):[]
  };
}
function ingredientSet(items=[]){
  return [...new Set(items.map(x=>x?.canonicalName||canonicalIngredientName(x?.name||x)).filter(Boolean))].sort();
}
function ingredientSetScore(rxIngredients=[],packIngredients=[]){
  const rx=ingredientSet(rxIngredients), pk=ingredientSet(packIngredients);
  if(!rx.length || !pk.length) return 0;
  if(rx.length!==pk.length) return 0;
  let total=0;
  const used=new Set();
  for(const r of rx){
    let best=-1,bestScore=0;
    for(let i=0;i<pk.length;i++){
      if(used.has(i)) continue;
      const score=(r===pk[i]) ? 1 : nameSimilarity(r,pk[i]);
      if(score>bestScore){bestScore=score;best=i;}
    }
    if(best<0 || bestScore<0.86) return 0;
    used.add(best); total+=bestScore;
  }
  return total/rx.length;
}
function findBestRxMatch(pack){
  let best=null;
  for(const med of state.rxMeds){
    if(med.genericMappingConfidence<0.75 || !(med.genericIngredients||[]).length) continue;
    const score=ingredientSetScore(med.genericIngredients,pack.ingredients);
    if(!best || score>best.score) best={med,score};
  }
  return best;
}
function modifiedReleaseMismatch(pack, med){
  const rxMR=/\b(SR|ER|XR|CR|MR|PR|XL|LA|retard|controlled\s*release|extended\s*release|sustained\s*release)\b/i.exec(`${med.name} ${med.sourceLine||''}`);
  if(pack.modified && !rxMR) return true;
  if(pack.modified && rxMR && pack.modified!==rxMR[1].toUpperCase()) return true;
  return false;
}
function perDoseUnits(med,pack){
  const doseText=String(med.dose||med.sourceLine||'');
  const explicit=doseText.match(/\b(\d+(?:\.\d+)?)\s*(tablets?|tabs?|capsules?|caps?|units?|puffs?|drops?)\b/i);
  if(explicit){
    const n=parseFloat(explicit[1]);
    if(n>0 && n<=4) return {units:n,reason:''};
  }
  const rxStrength=parseStrength(doseText), packStrength=pack.strengthObj;
  if(!rxStrength || !packStrength) return {units:null,reason:'गोली या इकाई की सही संख्या स्पष्ट नहीं है'};
  const ratio=comparableStrength(rxStrength,packStrength);
  if(ratio===null) return {units:null,reason:'पर्ची की खुराक और पैक की ताकत की इकाइयाँ आपस में नहीं मिल रहीं'};
  const rounded=Math.round(ratio*100)/100;
  if(rounded<=0 || rounded>4) return {units:null,reason:'निकली हुई मात्रा असामान्य है'};
  if(Math.abs(rounded-Math.round(rounded))<.001) return {units:Math.round(rounded),reason:''};
  return {units:null,reason:'आधी या टूटी हुई गोली की आवश्यकता हो सकती है'};
}
function scheduleFromPattern(freq=''){
  const m=String(freq).replace(/\s/g,'').match(/^([0-9])[-–]([0-9])[-–]([0-9])$/);
  return m?{morning:+m[1],afternoon:+m[2],night:+m[3]}:null;
}
function scheduleSentence(freq,form,voice=false){
  const s=scheduleFromPattern(freq); if(!s) return '';
  const parts=[];
  for(const [label,n] of [['सुबह',s.morning],['दोपहर',s.afternoon],['रात',s.night]]){
    if(n>0) parts.push(`${label} ${voice?numberWord(n):displayNumber(n)} ${unitHindi(form,n)}`);
  }
  if(!parts.length) return '';
  return `${parts.join(' और ')} लें`;
}
function quantityFrequencySentence(freq,qty){
  const f=String(freq).toUpperCase().replace(/\s/g,'');
  if(f==='ODBBF') return `सुबह खाली पेट ${qty} लें`;
  if(f==='ODHS') return `रात को सोने से पहले ${qty} लें`;
  if(['OD','QD'].includes(f)) return `दिन में एक बार ${qty} लें`;
  if(['BD','BID'].includes(f)) return `दिन में दो बार ${qty} लें`;
  if(['TDS','TID'].includes(f)) return `दिन में तीन बार ${qty} लें`;
  if(['QID','QDS'].includes(f)) return `दिन में चार बार ${qty} लें`;
  if(f==='ABF') return `नाश्ते के बाद ${qty} लें`;
  if(f==='BL') return `दोपहर के खाने से पहले ${qty} लें`;
  if(f==='AL') return `दोपहर के खाने के बाद ${qty} लें`;
  if(f==='AD') return `रात के खाने के बाद ${qty} लें`;
  if(f==='HS') return `रात को सोने से पहले ${qty} लें`;
  if(['SOS','PRN'].includes(f)) return `ज़रूरत पड़ने पर ${qty} लें`;
  if(f==='STAT') return `अभी ${qty} लें`;
  return `${frequencyHindi(freq)} ${qty} लें`;
}
function frequencySentence(freq,units,form,voice=false){
  const count=voice?numberWord(units):displayNumber(units);
  const unit=unitHindi(form,units);
  return quantityFrequencySentence(freq,`${count} ${unit}`);
}

async function prepareImage(file){
  let blob=file;
  const n=(file.name||'').toLowerCase();
  if(file.type.includes('heic') || file.type.includes('heif') || /\.(heic|heif)$/i.test(n)){
    if(typeof heic2any!=='function') throw new Error('यह तस्वीर नहीं खुल सकी। जेपीजी या पीएनजी तस्वीर चुनें।');
    const converted=await heic2any({blob:file,toType:'image/jpeg',quality:.92});
    blob=Array.isArray(converted)?converted[0]:converted;
  }
  return blob;
}
async function decodeImageSource(blob){
  if('createImageBitmap' in window){ try{return await createImageBitmap(blob,{imageOrientation:'from-image'});}catch(_e){} }
  return await new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(blob), img=new Image();
    img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('तस्वीर नहीं खुल सकी।'));};
    img.src=url;
  });
}
async function imageToDataUrl(blob){
  const source=await decodeImageSource(blob);
  const sw=source.width||source.naturalWidth, sh=source.height||source.naturalHeight;
  if(!sw||!sh) throw new Error('तस्वीर का आकार पढ़ा नहीं जा सका।');
  const scale=Math.min(1,2800/Math.max(sw,sh));
  const w=Math.max(1,Math.round(sw*scale)), h=Math.max(1,Math.round(sh*scale));
  const canvas=document.createElement('canvas'); canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d'); if(!ctx) throw new Error('तस्वीर तैयार नहीं हो सकी।');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(source,0,0,w,h);
  if(typeof source.close==='function') source.close();
  const out=await new Promise(res=>canvas.toBlob(res,'image/jpeg',.92));
  if(!out) throw new Error('तस्वीर तैयार नहीं हो सकी।');
  return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=()=>reject(new Error('तस्वीर पढ़ी नहीं जा सकी।'));r.readAsDataURL(out);});
}
function setMessage(kind,message='',isError=false){
  const box=$(kind==='rx'?'rxVisionDiagnostic':'medVisionDiagnostic');
  if(!message){setHidden(box,true);return;}
  box.textContent=message;box.className=`message ${isError?'error':''}`;setHidden(box,false);
}
function setProgress(kind,text,show=true){
  const prefix=kind==='rx'?'rx':'med';
  $(`${prefix}ProgressText`).textContent=text; setHidden($(`${prefix}Progress`),!show);
}
async function runVision(blob,kind){
  setMessage(kind,'');
  setProgress(kind,'तस्वीर तैयार की जा रही है…');
  const image=await imageToDataUrl(blob);
  setProgress(kind,kind==='rx'?'पर्ची पढ़ी जा रही है…':'दवा का पैक पढ़ा जा रहा है…');
  const endpoint=kind==='rx'?'/api/analyze-prescription':'/api/analyze-medicine';
  let response;
  try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image})});}
  catch(_e){throw new Error('दवा साथी के सर्वर से संपर्क नहीं हो सका। कृपया दोबारा कोशिश करें।');}
  let payload={}; try{payload=await response.json();}catch(_e){}
  if(!response.ok||!payload.ok) throw new Error(payload.error||'तस्वीर पढ़ी नहीं जा सकी।');
  setProgress(kind,'',false);
  return payload.result||{};
}
async function checkBackend(){
  if(location.protocol==='file:'){
    setMessage('rx','दवा साथी को स्टार्ट फ़ाइल से खोलें। सीधे वेब फ़ाइल पर दो बार क्लिक न करें।',true);return;
  }
  try{
    const r=await fetch('/api/health',{cache:'no-store'}), h=await r.json();
    if(!h.api_key_configured) setMessage('rx','सेवा अभी उपलब्ध नहीं है। कृपया व्यवस्थापक से संपर्क करें।',true);
  }catch(_e){setMessage('rx','दवा साथी के सर्वर से संपर्क नहीं हो सका। कृपया दोबारा कोशिश करें।',true);}
}
function showRxImage(blob){
  state.rxBlob=blob; state.rxMeds=[]; state.rxAdviceHindi=[];
  $('rxPreview').src=URL.createObjectURL(blob); setHidden($('rxPreviewWrap'),false); setHidden($('rxResultsCard'),true); setProgress('rx','',false); setMessage('rx','');
  disableMedicine();
}
function showMedImage(blob){
  state.medBlob=blob; $('medPreview').src=URL.createObjectURL(blob); setHidden($('medPreviewWrap'),false); setHidden($('medResult'),true); setProgress('med','',false); setMessage('med','');
}
async function handleRxFile(file){if(!file)return;try{showRxImage(await prepareImage(file));}catch(e){setMessage('rx',e.message||'तस्वीर नहीं खुल सकी।',true);}}
async function handleMedFile(file){if(!file)return;try{showMedImage(await prepareImage(file));}catch(e){setMessage('med',e.message||'तस्वीर नहीं खुल सकी।',true);}}

function renderRx(parsed){
  state.rxMeds=parsed.meds; state.rxAdviceHindi=parsed.adviceHindi;
  const list=$('rxMedicineList'); list.innerHTML='';
  if(parsed.meds.length){
    for(const med of parsed.meds){
      const details=[];
      if(med.dose) details.push(`खुराक: ${strengthHindi(med.dose) || displayNumber(med.dose)}`);
      if(med.frequency) details.push(`कितनी बार: ${frequencyHindi(med.frequency)}`);
      if(med.route && routeHindi(med.route)) details.push(`कैसे: ${routeHindi(med.route)}`);
      if(med.duration) details.push(`कितने समय: ${durationHindi(med.duration)}`);
      const name=med.genericNameHindi||med.nameHindi||'दवा का नाम स्पष्ट नहीं';
      const genericNote=med.genericName
        ? `<div class="rx-note">जेनेरिक दवा: ${escapeHtml(med.genericName)}</div>`
        : `<div class="rx-note">जेनेरिक नाम भरोसेमंद तरीके से तय नहीं हो सका।</div>`;
      list.insertAdjacentHTML('beforeend',`<div class="rx-item"><div class="rx-name">${escapeHtml(name)}</div><div class="rx-details">${details.map(x=>`<span class="pill">${escapeHtml(x)}</span>`).join('')}</div>${genericNote}${med.instructionsHindi?`<div class="rx-note">${escapeHtml(med.instructionsHindi)}</div>`:''}</div>`);
    }
  }else{
    list.innerHTML='<div class="rx-item"><div class="rx-name">कोई दवा साफ़ नहीं पढ़ी गई</div><div class="rx-note">अगर पर्ची में दवा लिखी है, तो डॉक्टर या फार्मासिस्ट से पुष्टि करें।</div></div>';
  }
  const advice=$('rxAdviceBox');
  if(parsed.adviceHindi.length){
    advice.innerHTML=`<b>पर्ची में दूसरी सलाह</b>${parsed.adviceHindi.map(x=>`<div>• ${escapeHtml(x)}</div>`).join('')}`;setHidden(advice,false);
  }else setHidden(advice,true);
  setHidden($('rxResultsCard'),false);
  if(parsed.meds.length) enableMedicine(); else disableMedicine('पर्ची में दवा साफ़ नहीं मिली।');
  $('rxResultsCard').scrollIntoView({behavior:'smooth',block:'start'});
}
function disableMedicine(hint='पहले प्रिस्क्रिप्शन पढ़ें।'){
  $('medicineCard').classList.remove('ready');$('medicineCard').setAttribute('aria-disabled','true');
  medInputs.forEach(i=>i.disabled=true);$('medicineHint').textContent=hint;
}
function enableMedicine(){
  $('medicineCard').classList.add('ready');$('medicineCard').setAttribute('aria-disabled','false');
  medInputs.forEach(i=>i.disabled=false);$('medicineHint').textContent='एक समय में एक दवा का पैक दिखाएँ।';
}

let currentAudio=null;
async function speakHindi(text, button=null){
  if(!text) return;
  state.currentSpeech=text;
  if(button){ button.disabled=true; button.textContent='🔊 आवाज़ तैयार हो रही है…'; }
  try{
    if(currentAudio){ currentAudio.pause(); currentAudio=null; }
    const r=await fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    if(!r.ok){
      let message='आवाज़ नहीं बन सकी।';
      try{const j=await r.json(); if(j.error) message=j.error;}catch(_e){}
      throw new Error(message);
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const audio=new Audio(url);
    currentAudio=audio;
    audio.onended=()=>{ URL.revokeObjectURL(url); if(currentAudio===audio) currentAudio=null; };
    audio.onerror=()=>{ URL.revokeObjectURL(url); if(currentAudio===audio) currentAudio=null; };
    await audio.play();
  }catch(e){
    console.error(e);
    setMessage('med',e.message||'आवाज़ नहीं चल सकी।',true);
  }finally{
    if(button){ button.disabled=false; button.textContent='🔊 फिर सुनें'; }
  }
}
function makeGuidance(match,pack){
  if(!match || match.score<.86){
    const n=pack.nameHindi||'यह दवा';
    return {type:'no-match',title:'यह दवा पर्ची में नहीं मिली',spoken:`${n} के जेनेरिक घटक आपकी पर्ची में लिखी दवा के जेनेरिक घटकों से मेल नहीं खाते। इसे लेने से पहले डॉक्टर या फार्मासिस्ट से पुष्टि करें।`,facts:'मिलान ब्रांड नाम से नहीं, जेनेरिक दवा के घटकों से किया गया।'};
  }
  const med=match.med, n=med.nameHindi||pack.nameHindi||'यह दवा';
  if(pack.overallConfidence<.55){
    return {type:'warn',title:'दवा की तस्वीर साफ़ नहीं पढ़ी गई',spoken:`${n} की जानकारी साफ़ नहीं पढ़ी गई। इसे लेने से पहले डॉक्टर या फार्मासिस्ट से पुष्टि करें।`,facts:'दवा का नाम या ताकत साफ़ पढ़ी नहीं गई।'};
  }
  if(pack.complex){
    return {type:'warn',title:'इस दवा में एक से अधिक दवाएँ हैं',spoken:`${n} में एक से अधिक दवा के घटक दिख रहे हैं। इसकी सही मात्रा डॉक्टर या फार्मासिस्ट से पुष्टि करें।`,facts:'मिश्रित दवा की मात्रा अपने-आप तय नहीं की गई।'};
  }
  if(modifiedReleaseMismatch(pack,med)){
    return {type:'warn',title:'दवा का प्रकार अलग हो सकता है',spoken:`${n} का नाम मिलता है, लेकिन पैक का प्रकार पर्ची से अलग हो सकता है। इसे लेने से पहले डॉक्टर या फार्मासिस्ट से पुष्टि करें।`,facts:'धीरे-धीरे दवा छोड़ने वाला विशेष प्रकार पर्ची से साफ़ तौर पर नहीं मिला।'};
  }

  const sched=scheduleFromPattern(med.frequency);
  const calc=perDoseUnits(med,pack);
  const liquidDoseDisplay=volumeDoseHindi(med.dose,false);
  const liquidDoseVoice=volumeDoseHindi(med.dose,true);
  const liquidForm=/syrup|solution|suspension|liquid/i.test(pack.form||'');
  let instructionDisplay='', instructionVoice='';
  if(liquidForm && liquidDoseDisplay){
    if(sched){
      const parts=[];
      for(const [label,n] of [['सुबह',sched.morning],['दोपहर',sched.afternoon],['रात',sched.night]]) if(n>0) parts.push(`${label} ${liquidDoseDisplay}`);
      instructionDisplay=`${parts.join(' और ')} लें`;
      const voiceParts=[];
      for(const [label,n] of [['सुबह',sched.morning],['दोपहर',sched.afternoon],['रात',sched.night]]) if(n>0) voiceParts.push(`${label} ${liquidDoseVoice}`);
      instructionVoice=`${voiceParts.join(' और ')} लें`;
    }else{
      instructionDisplay=quantityFrequencySentence(med.frequency,liquidDoseDisplay);
      instructionVoice=quantityFrequencySentence(med.frequency,liquidDoseVoice);
    }
  }else if(sched){
    instructionDisplay=scheduleSentence(med.frequency,pack.form,false);
    instructionVoice=scheduleSentence(med.frequency,pack.form,true);
  }else if(calc.units){
    instructionDisplay=frequencySentence(med.frequency,calc.units,pack.form,false);
    instructionVoice=frequencySentence(med.frequency,calc.units,pack.form,true);
  }else{
    const f=frequencyHindi(med.frequency);
    instructionDisplay=f?`${f} लें`:'लेने की सही संख्या स्पष्ट नहीं है';
    instructionVoice=instructionDisplay;
  }

  const durationD=durationHindi(med.duration), durationV=durationVoice(med.duration);
  const routeInstruction=routeInstructionHindi(med.route);
  const sentences=[`${n}: ${instructionDisplay}।`];
  const voice=[`${n}। ${instructionVoice}।`];
  if(durationD){sentences.push(`${durationD} तक लें।`);voice.push(`${durationV||durationD} तक लें।`);}
  if(routeInstruction){sentences.push(`${routeInstruction}।`);voice.push(`${routeInstruction}।`);}
  if(med.instructionsHindi){sentences.push(`${med.instructionsHindi.replace(/[।.]+$/,'')}।`);voice.push(`${med.instructionsHindi.replace(/[।.]+$/,'')}।`);}
  if(!calc.units && !sched){
    sentences.push(`${calc.reason}। डॉक्टर या फार्मासिस्ट से पुष्टि करें।`);
    voice.push(`${calc.reason}। डॉक्टर या फार्मासिस्ट से पुष्टि करें।`);
  }
  const isSafe=!!(sched||calc.units||(liquidForm&&liquidDoseDisplay));
  return {type:isSafe?'match':'warn',title:isSafe?'पर्ची से दवा मिल गई':'दवा मिली, मात्रा स्पष्ट नहीं',spoken:voice.join(' '),body:sentences.join(' '),facts:`पैक की ताकत: ${strengthHindi(pack.strength)||'स्पष्ट नहीं'}। पर्ची की खुराक: ${strengthHindi(med.dose)||'स्पष्ट नहीं'}।`};
}
function renderMedResult(pack,match,g){
  const matched=match?.med;
  const name=pack.nameHindi||matched?.nameHindi||'दवा';
  $('medResult').className=`result ${g.type}`;
  $('medResult').innerHTML=`
    <h3>${escapeHtml(g.title)}</h3>
    <div class="spoken">${escapeHtml(g.body||g.spoken)}</div>
    <div class="facts"><b>${escapeHtml(name)}</b><br>${escapeHtml(g.facts||'')}</div>
    <div class="result-actions">
      <button class="primary" id="speakAgainBtn">🔊 फिर सुनें</button>
      <button class="plain" id="nextMedBtn">अगली दवा</button>
    </div>`;
  setHidden($('medResult'),false);
  $('speakAgainBtn').addEventListener('click',(e)=>speakHindi(g.spoken,e.currentTarget));
  $('nextMedBtn').addEventListener('click',resetMedicine);
  state.history.push({name,summary:g.body||g.spoken});renderHistory();
  speakHindi(g.spoken,$('speakAgainBtn'));
}
function renderHistory(){
  if(!state.history.length){setHidden($('historyCard'),true);return;}
  $('historyList').innerHTML=state.history.map(h=>`<div class="history-item"><b>${escapeHtml(h.name)}</b><small>${escapeHtml(h.summary)}</small></div>`).join('');
  setHidden($('historyCard'),false);
}
function resetMedicine(){
  state.medBlob=null;medInputs.forEach(i=>i.value='');setHidden($('medPreviewWrap'),true);setHidden($('medResult'),true);setProgress('med','',false);setMessage('med','');
  $('medicineCard').scrollIntoView({behavior:'smooth',block:'start'});
}

rxInputs.forEach(input=>input.addEventListener('change',e=>handleRxFile(e.target.files?.[0])));
medInputs.forEach(input=>input.addEventListener('change',e=>handleMedFile(e.target.files?.[0])));
$('replaceRxBtn').addEventListener('click',()=>$('rxFileInput').click());
$('replaceMedBtn').addEventListener('click',()=>$('medFileInput').click());
$('analyzeRxBtn').addEventListener('click',async()=>{
  if(!state.rxBlob)return;
  $('analyzeRxBtn').disabled=true;
  try{const v=await runVision(state.rxBlob,'rx');renderRx(prescriptionVisionToParsed(v));setMessage('rx','पर्ची पढ़ ली गई।');}
  catch(e){console.error(e);setProgress('rx','',false);setMessage('rx',e.message||'पर्ची पढ़ी नहीं जा सकी।',true);}
  finally{$('analyzeRxBtn').disabled=false;}
});
$('analyzeMedBtn').addEventListener('click',async()=>{
  if(!state.medBlob||!state.rxMeds.length)return;
  $('analyzeMedBtn').disabled=true;
  try{const v=await runVision(state.medBlob,'med');const pack=medicineVisionToPack(v);const match=findBestRxMatch(pack);renderMedResult(pack,match,makeGuidance(match,pack));}
  catch(e){console.error(e);setProgress('med','',false);setMessage('med',e.message||'दवा पढ़ी नहीं जा सकी।',true);}
  finally{$('analyzeMedBtn').disabled=false;}
});

disableMedicine();
checkBackend();
