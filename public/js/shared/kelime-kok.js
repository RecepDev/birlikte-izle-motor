// İngilizce bir kelimenin sözlükte aranacak biçimleri (DOM'suz, saf).
//
// Altyazıda "held", "running", "honoured" geçiyor; sözlükte "hold", "run", "honor"
// yazıyor. Burada yalnız ÇEKİM ekleri atılıyor (çokluk, zaman, derece): kelimenin
// anlamı değişmiyor, yalnız biçimi. Yapım ekleri (-er, -ness, -ment) kasten
// atılmıyor: "undertaker" için "undertake" karşılığını (girişmek) göstermek,
// hiç göstermemekten kötü. Karşılık yoksa kutu o kelime için sessiz kalıyor.

// Düzensiz fiiller ve çoğullar: çekimli biçim -> kök.
const DUZENSIZ = new Map();
for (const [kok, bicimler] of Object.entries({
  be: 'am is are was were been being', have: 'has had having', do: 'does did done doing',
  go: 'goes went gone going', say: 'says said', get: 'gets got gotten getting',
  make: 'makes made making', know: 'knows knew known', think: 'thinks thought',
  take: 'takes took taken taking', see: 'sees saw seen seeing', come: 'comes came coming',
  find: 'finds found', give: 'gives gave given giving', tell: 'tells told',
  feel: 'feels felt', become: 'becomes became becoming', leave: 'leaves left leaving',
  put: 'puts putting', mean: 'means meant', keep: 'keeps kept keeping', let: 'lets letting',
  begin: 'begins began begun beginning', show: 'shows showed shown',
  hear: 'hears heard', run: 'runs ran running', bring: 'brings brought',
  write: 'writes wrote written writing', sit: 'sits sat sitting',
  stand: 'stands stood standing', lose: 'loses lost losing', pay: 'pays paid',
  meet: 'meets met meeting', set: 'sets setting', learn: 'learns learnt',
  lead: 'leads led leading', understand: 'understands understood',
  speak: 'speaks spoke spoken speaking', spend: 'spends spent spending',
  grow: 'grows grew grown growing', win: 'wins won winning', buy: 'buys bought',
  send: 'sends sent sending', build: 'builds built building',
  fall: 'falls fell fallen falling', cut: 'cuts cutting',
  rise: 'rises rose risen rising', drive: 'drives drove driven driving',
  break: 'breaks broke broken breaking', wear: 'wears wore worn wearing',
  choose: 'chooses chose chosen choosing', eat: 'eats ate eaten eating',
  drink: 'drinks drank drunk drinking', sell: 'sells sold selling',
  teach: 'teaches taught', catch: 'catches caught catching',
  fight: 'fights fought fighting', throw: 'throws threw thrown throwing',
  hold: 'holds held holding', sleep: 'sleeps slept sleeping', weep: 'weeps wept weeping',
  sing: 'sings sang sung singing', swim: 'swims swam swum swimming',
  ring: 'rings rang rung ringing', bite: 'bites bit bitten biting',
  hide: 'hides hid hidden hiding', shoot: 'shoots shot shooting',
  steal: 'steals stole stolen stealing', strike: 'strikes struck striking',
  swear: 'swears swore sworn swearing', tear: 'tears tore torn tearing',
  wake: 'wakes woke woken waking', forget: 'forgets forgot forgotten forgetting',
  forgive: 'forgives forgave forgiven forgiving', hang: 'hangs hung hanging',
  hurt: 'hurts hurting', lay: 'lays laid laying', lie: 'lies lay lain lying',
  light: 'lights lit lighting', ride: 'rides rode ridden riding',
  shake: 'shakes shook shaken shaking', shine: 'shines shone shining',
  shut: 'shuts shutting', spread: 'spreads spreading', stick: 'sticks stuck sticking',
  swing: 'swings swung swinging', blow: 'blows blew blown blowing',
  draw: 'draws drew drawn drawing', fly: 'flies flew flown flying',
  freeze: 'freezes froze frozen freezing', hit: 'hits hitting', kneel: 'kneels knelt',
  lend: 'lends lent lending', quit: 'quits quitting', seek: 'seeks sought seeking',
  shrink: 'shrinks shrank shrunk', sink: 'sinks sank sunk sinking',
  slide: 'slides slid sliding', spin: 'spins spun spinning', split: 'splits splitting',
  stink: 'stinks stank stunk', strive: 'strives strove striven', sweep: 'sweeps swept',
  wind: 'winds wound winding', withdraw: 'withdraws withdrew withdrawn',
  bear: 'bears bore borne bearing', beat: 'beats beaten beating',
  bend: 'bends bent bending', bind: 'binds bound binding', bleed: 'bleeds bled bleeding',
  breed: 'breeds bred breeding', burst: 'bursts bursting', cast: 'casts casting',
  cling: 'clings clung clinging', creep: 'creeps crept creeping', deal: 'deals dealt dealing',
  dig: 'digs dug digging', feed: 'feeds fed feeding', flee: 'flees fled fleeing',
  grind: 'grinds ground grinding', leap: 'leaps leapt leaping',
  mistake: 'mistakes mistook mistaken', overcome: 'overcomes overcame overcoming',
  rid: 'rids ridding', shed: 'sheds shedding', slay: 'slays slew slain slaying',
  sow: 'sows sowed sown', spit: 'spits spat spitting', thrust: 'thrusts thrusting',
  tread: 'treads trod trodden', undergo: 'undergoes underwent undergone',
  upset: 'upsets upsetting', weave: 'weaves wove woven', wring: 'wrings wrung wringing',
})) {
  for (const b of bicimler.split(' ')) if (!DUZENSIZ.has(b)) DUZENSIZ.set(b, kok);
}
for (const [cogul, tekil] of Object.entries({
  men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth',
  geese: 'goose', mice: 'mouse', people: 'person', lives: 'life', wives: 'wife',
  knives: 'knife', leaves: 'leaf', thieves: 'thief', wolves: 'wolf', selves: 'self',
  halves: 'half', loaves: 'loaf', shelves: 'shelf', calves: 'calf',
})) DUZENSIZ.set(cogul, tekil);

// İngiliz yazımı -> Amerikan yazımı (sözlük Amerikan yazımını taşıyor).
const YAZIM = [
  ['our', 'or'], ['ise', 'ize'], ['isation', 'ization'], ['ising', 'izing'], ['ised', 'ized'],
  ['yse', 'yze'], ['ogue', 'og'], ['aemia', 'emia'], ['centre', 'center'], ['metre', 'meter'],
  ['theatre', 'theater'], ['fibre', 'fiber'], ['ll', 'l'],
];

function amerikan(kelime) {
  const out = [];
  for (const [desen, yeni] of YAZIM) {
    if (desen === 'll') {
      // travelled -> traveled (yalnız sonek öncesi çift l)
      const m = kelime.match(/^(.*[aeiou][a-z]*)ll(ed|ing|er)$/);
      if (m) out.push(`${m[1]}l${m[2]}`);
    } else if (kelime.includes(desen)) out.push(kelime.replace(desen, yeni));
  }
  return out;
}

// Çekim ekleri: çokluk, zaman, derece. Anlam değişmiyor.
function cekimler(w) {
  const out = [];
  const ekle = (x) => { if (x && x.length > 1 && !out.includes(x)) out.push(x); };
  if (DUZENSIZ.has(w)) ekle(DUZENSIZ.get(w));
  if (w.endsWith('ies') && w.length > 4) ekle(`${w.slice(0, -3)}y`);
  if (w.endsWith('ves') && w.length > 4) { ekle(`${w.slice(0, -3)}f`); ekle(`${w.slice(0, -3)}fe`); }
  if (w.endsWith('es') && w.length > 3) { ekle(w.slice(0, -2)); ekle(w.slice(0, -1)); }
  if (w.endsWith('s') && !w.endsWith('ss')) ekle(w.slice(0, -1));
  if (w.endsWith('ied') && w.length > 4) ekle(`${w.slice(0, -3)}y`);
  if (w.endsWith('ed') && w.length > 3) {
    ekle(w.slice(0, -2));
    ekle(w.slice(0, -1));
    if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) ekle(w.slice(0, -3));
  }
  if (w.endsWith('ying') && w.length > 5) ekle(`${w.slice(0, -4)}ie`);
  if (w.endsWith('ing') && w.length > 4) {
    ekle(w.slice(0, -3));
    ekle(`${w.slice(0, -3)}e`);
    if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) ekle(w.slice(0, -4));
  }
  if (w.endsWith('est') && w.length > 5) { ekle(w.slice(0, -3)); ekle(w.slice(0, -2)); }
  if (w.endsWith("n't")) ekle(w.slice(0, -3));
  return out;
}

// Sözlükte denenecek bütün biçimler, güvenilirlik sırasıyla.
export function kokAdaylari(kelime) {
  const w = String(kelime).toLowerCase();
  const out = [w];
  const ekle = (x) => { if (x && x.length > 1 && !out.includes(x)) out.push(x); };
  for (const a of amerikan(w)) ekle(a);
  // Altyazılarda sık görülen tarama hatası: büyük I küçük l okunmuş (ltaly -> italy).
  if (w.startsWith('l') && w.length > 3) ekle(`i${w.slice(1)}`);
  if (w.includes('-')) for (const parca of w.split('-')) if (parca.length > 3) ekle(parca);
  for (const taban of [...out]) for (const c of cekimler(taban)) ekle(c);
  return out;
}
