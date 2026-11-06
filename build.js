#!/usr/bin/env node
// 文献分类订阅：抓取期刊与工作论文的摘要，按“主题 x 是否用博弈论”分成三类，输出 RSS。
// 用法：node build.js --since 2026-09-01 --ssrn-since 2026-10-20 --out ./out
'use strict';
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith('--')) a.push([x.slice(2), all[i + 1]]);
  return a;
}, []));
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const SINCE = args.since || daysAgo(150);
const SSRN_SINCE = args['ssrn-since'] || daysAgo(10);
const T5_SINCE = args['t5-since'] || daysAgo(365);
const ONLY_TOP5 = process.argv.includes('--only-top5');
const TOP5 = new Set(['American Economic Review', 'Econometrica', 'Journal of Political Economy', 'Quarterly Journal of Economics', 'Review of Economic Studies']);
const OUT = args.out || path.join(__dirname, 'out');
const CACHE_FILE = path.join(__dirname, 'cache', 'repec-abstracts.json');
const UA = { 'User-Agent': 'literature-feed/1.0' };

// 期刊：repec 为 IDEAS 上 Elsevier 期刊的代码，用来补 Crossref/OpenAlex 缺失的摘要
const JOURNALS = [
  ['Management Science', '0025-1909'], ['Operations Research', '0030-364X'],
  ['M&SOM', '1523-4614'], ['POMS', '1059-1478'], ['Journal of Operations Management', '0272-6963'],
  ['Information Systems Research', '1047-7047'], ['MIS Quarterly', '0276-7783'],
  ['JMIS', '0742-1222'], ['Marketing Science', '0732-2399'],
  ['Journal of Marketing Research', '0022-2437'], ['Journal of Marketing', '0022-2429'],
  ['Omega', '0305-0483', 'jomega'], ['IJPE', '0925-5273', 'proeco'], ['EJOR', '0377-2217', 'ejores'],
  ['Transportation Research Part E', '1366-5545', 'transe'], ['Decision Support Systems', '0167-9236', 'decsup'],
  ['Naval Research Logistics', '0894-069X'], ['Decision Sciences', '0011-7315'],
  ['American Economic Review', '0002-8282', 'aea/aecrev'],
  ['Econometrica', '0012-9682', 'wly/emetrp'], ['Journal of Political Economy', '0022-3808', 'ucp/jpolec'],
  ['Quarterly Journal of Economics', '0033-5533', 'oup/qjecon'], ['Review of Economic Studies', '0034-6527', 'oup/restud'],
  ['RAND Journal of Economics', '0741-6261'], ['JEMS', '1058-6407'],
  ['IJIO', '0167-7187', 'indorg'], ['Games and Economic Behavior', '0899-8256', 'gamebe'],
  ['Information Economics and Policy', '0167-6245', 'iepoli'],
];
const RSS_SOURCES = [
  ['arXiv', 'https://export.arxiv.org/api/query?search_query=(cat:cs.GT+OR+cat:econ.TH)+AND+(abs:platform+OR+abs:marketplace+OR+abs:%22supply+chain%22+OR+abs:%22data+market%22+OR+abs:%22data+sharing%22+OR+abs:%22data+pricing%22+OR+abs:%22artificial+intelligence%22+OR+abs:%22generative+AI%22+OR+abs:%22large+language+model%22+OR+abs:%22AI+agent%22+OR+abs:%22algorithmic+pricing%22)&sortBy=submittedDate&sortOrder=descending&max_results=100'],
  ['NEP-GTH', 'https://nep.repec.org/rss/nep-gth.rss.xml'], ['NEP-AIN', 'https://nep.repec.org/rss/nep-ain.rss.xml'],
  ['NEP-CTA', 'https://nep.repec.org/rss/nep-cta.rss.xml'], ['NEP-IND', 'https://nep.repec.org/rss/nep-ind.rss.xml'],
  ['NEP-COM', 'https://nep.repec.org/rss/nep-com.rss.xml'], ['NEP-DES', 'https://nep.repec.org/rss/nep-des.rss.xml'],
  ['NEP-ICT', 'https://nep.repec.org/rss/nep-ict.rss.xml'], ['NBER', 'https://www.nber.org/rss/new.xml'],
];

// ---------- 分类规则 ----------
const TOPICS = {
  平台经济: /\bplatforms?\b|two-sided|multi-sided|multisided|\bmarketplaces?\b|gig (economy|work)|sharing economy|ride-?hailing|ride-?sourcing|app stores?|e-?commerce|live[- ]?streaming|content creators?|network effects?|crowdsourcing|crowdfunding/i,
  数据经济: /data (market|economy|sharing|pricing|broker|intermediar|privacy|governance|monetiz|trading|asset|ownership|acquisition|disclosure|protection|portability)|personal data|consumer data|user data|data-driven pricing|information sharing|privacy|personali[sz]ed pricing|price discrimination/i,
  供应链: /supply[- ]chains?|\bsuppliers?\b|\bretailers?\b|\bmanufacturers?\b|procurement|wholesale|dual[- ]channel|omni-?channel|distribution channel|closed-loop|reverse logistics|outsourcing|sourcing strateg|vendor|logistics service/i,
  人工智能: /[Aa]rtificial [Ii]ntelligence|\bAI\b|\b[Gg]enerative\b|[Ll]arge [Ll]anguage [Mm]odels?|\bLLMs?\b|[Ff]oundation [Mm]odels?|[Aa]lgorithmic ([Pp]ricing|[Cc]ollusion|[Bb]ias|[Mm]anagement|[Dd]ecision|[Rr]ecommendation|[Ff]airness)|[Pp]ricing [Aa]lgorithms?|[Rr]ecommend(er|ation) ([Ss]ystem|[Aa]lgorithm)s?|[Cc]hatbots?|[Aa]gentic/,
};
// 强信号：出现一个即判定为博弈论
const GT_STRONG = [
  [/game[- ]theor/i, 'game theory'], [/stackelberg/i, 'Stackelberg'], [/\bnash\b/i, 'Nash'], [/subgame/i, 'subgame'],
  [/\b(evolutionary|differential|bayesian|signal(l)?ing|cooperative|non-?cooperative|repeated|dynamic|sequential|stochastic|bargaining|mean[- ]field|two-stage|three-stage|multi-stage|congestion|contest|coordination|simultaneous|leader-follower) games?\b/i, 'game model'],
  [/\b(a|the|this|our|in a|an?) (\w+[- ])?game(s)? (model|between|among|with|in which|where)\b/i, 'game model'],
  [/\bcournot\b/i, 'Cournot'], [/\bbertrand\b/i, 'Bertrand'], [/\bhotelling\b/i, 'Hotelling'],
  [/bayesian persuasion|information design|cheap talk/i, 'persuasion'], [/mechanism design|incentive[- ]compatib|revelation principle/i, 'mechanism design'],
  [/principal[- –]agent|moral hazard|adverse selection/i, 'agency'], [/\bsignal(l)?ing\b/i, 'signaling'],
  [/\bbargaining\b/i, 'bargaining'], [/shapley/i, 'Shapley'], [/\bauctions?\b/i, 'auction'],
  [/\bduopol|\boligopol/i, 'duopoly'], [/self-interested agents|strategic agents|truthful(ness)?\b|strategyproof|strategy-proof/i, 'mechanism design'],
  [/\bscreening (model|mechanism|contract|problem)|\bwe study an? (employer|principal|monopolist)\b/i, 'agency'],
  [/(unique|pure[- ]strategy|mixed[- ]strategy|symmetric|perfect|bayesian|market|in|equilibrium) equilibri(um|a)\b|equilibrium (strateg|outcome|price|pricing|decision|solution|analysis|characteri)/i, 'equilibrium'],
  [/best[- ]response/i, 'best response'], [/leader[- –]follower/i, 'leader-follower'], [/contract theory|optimal contract|contract design/i, 'contract'],
];
// 弱信号：需要两个不同的弱信号才算
const GT_WEAK = [
  [/equilibri/i, 'equilibrium'], [/strategic(ally)? (interaction|behavio|consumer|supplier|retailer|firm|platform|agent|user|seller|buyer|response|decision|incentive)/i, 'strategic'],
  [/analytical model|game|stylized model|theoretical model|economic model|we model|we develop a model|we build a model|model of competition/i, 'model'],
  [/\bduopol|\boligopol|\bmonopol|competing (firms|platforms|retailers|suppliers|manufacturers|sellers)/i, 'market structure'],
  [/incentive/i, 'incentive'], [/\bcontracts?\b/i, 'contract'],
];
const NOT_GAME = /video games?|mobile games?|online games?|gaming|game (industry|developer|player|design)s?|serious games?|game-based|tile-matching games?|game development/gi;
const NOT_SHAPLEY = /\bSHAP\b|shapley additive|explainab|interpretab/i;
const EMPIRICAL = /field experiment|randomi[sz]ed (controlled|experiment|trial|field)|difference-in-differences|natural experiment|quasi-experiment|panel data|survey (data|of|respondents)|evidence from|\busing (\w+ )?(data|dataset|transaction|proprietary|administrative|archival)|regression|\binterviews\b|case study|laboratory experiment|online experiment|structural estimation|we estimate|we exploit|we leverage|qualitative|meta-analysis|is associated with|are associated with|listed firms|firm-level/i;
// 这些词在实证论文里常只是理论视角，不代表用了博弈论模型
const SOFT = new Set(['auction', 'signaling', 'agency', 'equilibrium', 'mechanism design', 'contract', 'persuasion']);
// 纯优化或算法研究：没有策略互动时，不算博弈论
const OPTIMIZATION = /optimi[sz]ation (problem|framework|model)|heuristic|\bbandits?\b|\bregret\b|mixed[- ]integer|\bMILP\b|dynamic program|markov decision|reinforcement learning|column generation|branch-and|agent-based|simulation/i;
const STRATEGIC_CUE = /compet|strategic|duopol|oligopol|monopol|incentiv|bargain|contract|agency selling|reselling|liabilit|welfare|encroach|cooperat|coordinat/i;
const ECON = /\b(market|markets|firm|firms|price|prices|pricing|consumer|consumers|welfare|profit|profits|competition|competitive|incentive|incentives|regulation|seller|sellers|buyer|buyers|revenue|economic|economics|contract|contracts|demand)\b/gi;
const SCIENCE = /\b(cells?|proteins?|genes?|genomic|patients?|clinical|bacteria\w*|mutations?|tumou?rs?|polymers?|nanoparticles?|catalysts?|alloys?|sensors?|neural networks?|convolutional|deep learning|anomaly detection|federated learning|steganograph\w*|cancer|virus\w*|microb\w*|enzym\w*|knowledge management)\b/i;
// 理论模型线索：摘要没写博弈论，但像分析式建模
const MODEL_CUE = /\b(analytical|theoretical|stylized|formal|parsimonious|economic|game) (model|framework|analysis)|\bwe (develop|build|construct|propose|present|study|analy[sz]e|consider|introduce)\b[^.]{0,70}\bmodels?\b|\bwe (model|characteri[sz]e|derive|prove)\b|\bmodel(s|ing)? (of|how|where|in which)\b|\bour (model|analysis|results?) (shows?|reveals?|suggests?|indicates?)|\bwe show that\b|\b(platforms?|firms?|sellers?|retailers?|manufacturers?|suppliers?|monopolist|principal|employer) (chooses?|decides?|sets?|determines?|offers?)\b|\bcounterintuitive|\bsurprisingly\b|\bcompar(e|ing) (the )?(two|three|different) (strateg|model|mode|scheme|polic)/i;

function classify(p) {
  const title = p.title || '';
  const abs = p.abstract || '';
  const all = `${title} ${abs}`;
  const topics = [];
  let titleTopic = false;
  for (const [name, re] of Object.entries(TOPICS)) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    const inTitle = re.test(title);
    const hits = (abs.match(g) || []).length;
    if (inTitle) titleTopic = true;
    if (inTitle || hits >= 2) topics.push(name);
  }
  if (!topics.length) return null;
  const clean = all.replace(NOT_GAME, ' ');
  const strongOf = text => [...new Set(GT_STRONG.filter(([re]) => re.test(text)).map(x => x[1]))].filter(x => x !== 'Shapley' || !NOT_SHAPLEY.test(text));
  if (!abs) return { bin: 'C', label: '待判定', topics, evidence: strongOf(title) };
  const econ = new Set((all.match(ECON) || []).map(x => x.toLowerCase())).size;
  const ssrn = p.source === 'SSRN';
  if (ssrn && (SCIENCE.test(all) || econ < 3)) return null;
  const strong = strongOf(clean);
  const weak = [...new Set(GT_WEAK.filter(([re]) => re.test(clean)).map(x => x[1]))];
  const empirical = EMPIRICAL.test(all);
  const hard = strong.filter(x => !SOFT.has(x));
  const explicit = hard.length >= 1 || (strong.length >= 1 && !empirical && econ >= 2);
  const strategicCue = STRATEGIC_CUE.test(abs);
  const pureOptimization = OPTIMIZATION.test(all) && !weak.some(x => x === 'strategic' || x === 'market structure');
  const ssrnOk = !ssrn || weak.some(x => x === 'strategic' || x === 'market structure');
  const suspected = !explicit && !empirical && econ >= 3 && strategicCue && !pureOptimization && ssrnOk && (MODEL_CUE.test(abs) || weak.length >= 2);
  if (explicit) return { bin: 'A', label: '明确', topics, evidence: strong };
  if (suspected) return { bin: 'A', label: '疑似', topics, evidence: weak.length ? weak : ['理论模型'] };
  if (ssrn && !titleTopic) return null;
  return { bin: 'B', label: '', topics, evidence: [] };
}

// ---------- Top 5 分类：不限主题，只判断方法 ----------
// 这里不用单独的 equilibrium，因为宏观和增长论文里的 equilibrium 不代表博弈论
const T5_HARD = [
  [/game[- ]theor/i, 'game theory'], [/\bgames?\b/i, 'game'], [/stackelberg/i, 'Stackelberg'], [/\bnash\b/i, 'Nash'], [/subgame/i, 'subgame'],
  [/perfect bayesian|sequential equilibri|cursed equilibri|correlated equilibri|bayes(ian)?[- ]nash|mixed[- ]strateg|dominant[- ]strateg|best[- ]respon|level-k|solution concept|extensive[- ]form/i, 'equilibrium concept'],
  [/mechanism design|incentive[- ]compatib|strategy-?proof|revelation principle|implementation theory|optimal mechanism|robust mechanism/i, 'mechanism design'],
  [/information design|bayesian persuasion|\bpersua(sion|de)|cheap talk|\bsender\b/i, 'persuasion'],
  [/\bcournot\b|\bbertrand\b|\boligopol|\bduopol/i, 'oligopoly'],
  [/allocation mechanisms?|\bmechanisms? (for|with) (allocating|agents)/i, 'mechanism design'],
  [/repeated (game|interaction)|coordination (game|problem)|folk theorem/i, 'repeated game'],
  [/stable matching|matching mechanism|deferred acceptance|school choice|market design/i, 'market design'],
  [/principal[- –]agent|contract theory|optimal contract|dynamic contract|relational contract|incomplete contract/i, 'contract'],
];
// 这些词在实证论文里常只是研究对象，实证论文中不单独算
const T5_SOFT = [
  [/\bauctions?\b/i, 'auction'], [/\bbargaining\b/i, 'bargaining'], [/moral hazard|adverse selection/i, 'agency'],
  [/\bsignal(l)?ing\b|\bscreening\b/i, 'signaling'], [/\bcollusion\b|\bcartels?\b/i, 'collusion'], [/\bcontests?\b|\btournaments?\b/i, 'contest'],
  [/strategic(ally)? (interaction|complement|substitut|behavio|voting|communication|experimentation|delegation|uncertainty|information|disclosure|agent|player|firm|voter)/i, 'strategic'],
  [/\breputation/i, 'reputation'],
];
const T5_EMPIRICAL = new RegExp(EMPIRICAL.source + '|\\bwe use\\b|\\busing [^.]{0,40}data|data from|\\bwe document\\b|exploit|\\binstrument|\\bcausal|experiment|administrative|calibrat|quantitative|\\bestimates?\\b|\\bestimator|asymptotic', 'i');
// 博弈论式的互动线索：摘要没写博弈论，但有策略互动或信息不对称
const T5_CUE = /\bplayers?\b|\bprincipal\b|\bdesigner\b|\bprivate information\b|\basymmetric information\b|\bincomplete information\b|\bincentives?\b|\bstrategic\w*|\bvoters?\b|\bplatforms?\b|\bcompetition\b|\bcompet(e|ing)\b|\bcoalition\w*|\bhegemon\w*|\bcontacts\b|\bexporter\b/i;
// 理论文章的写法
const T5_THEORY = /\bwe (present|develop|propose|provide|study|analy[sz]e|consider|characteri[sz]e)\b[^.]{0,60}\b(model|theory|framework)\b|\ba (theory|model) (of|where|in which)\b|\bthis paper develops\b|\bwe show that\b|\bwe characteri[sz]e\b|\boptimal (response|strategy|mechanism|design)\b/i;
// 这些论文多用均衡分析，但不是博弈论
const T5_MACRO = /general equilibrium|spatial equilibrium|business cycle|monetary policy|new keynesian|macroeconom|macroprudential|economic growth|heterogeneous[- ]agent|\bHANK\b|\bDSGE\b|inflation|aggregate (demand|productivity|output)|\bGDP\b|asset pric|interest rate|capital flows|exchange rate|technological change|structural change/i;
// 没有摘要时，只看标题里的线索
const T5_TITLE_HINT = /strategic|\ba theory of\b|\bmechanisms?\b|\bcontracts?\b|\bauctions?\b|\bbargaining\b|persuasion|\bsignal(l)?ing\b|\bscreening\b|\bcompetition\b|\bcollusion\b/i;

function classifyTop5(p) {
  const title = p.title || '';
  const abs = p.abstract || '';
  const of = (list, text) => [...new Set(list.filter(([re]) => re.test(text)).map(x => x[1]))];
  if (!abs) {
    const h = of(T5_HARD, title.replace(NOT_GAME, ' '));
    return h.length || T5_TITLE_HINT.test(title) ? { bin: 'A', label: '疑似', evidence: h.length ? h : ['标题线索'] } : { bin: 'B', label: '待判定', evidence: [], showPending: true };
  }
  const all = `${title} ${abs}`;
  // 宏观搜寻模型里的 Nash bargaining 只是工资设定方式
  const clean = all.replace(NOT_GAME, ' ').replace(/nash[- ]bargain\w*/gi, ' ');
  const hard = of(T5_HARD, clean);
  const soft = of(T5_SOFT, clean);
  const empirical = T5_EMPIRICAL.test(all);
  if (hard.length) return { bin: 'A', label: '明确', evidence: [...hard, ...soft] };
  if (soft.length && !empirical) return { bin: 'A', label: '明确', evidence: soft };
  if (!empirical && !T5_MACRO.test(all) && T5_CUE.test(abs) && T5_THEORY.test(all)) return { bin: 'A', label: '疑似', evidence: ['理论模型'] };
  return { bin: 'B', label: '', evidence: [] };
}

// ---------- 抓取 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;[^&]*&gt;/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/^\s*Abstract[:.]?\s*/i, '').replace(/\s+/g, ' ').trim();
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { await sleep(2000 * (i + 1)); }
  }
  return null;
}
const fetchJson = async url => { const t = await fetchText(url); try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
const invert = idx => {
  if (!idx) return '';
  const w = [];
  for (const [k, ps] of Object.entries(idx)) for (const p of ps) w[p] = k;
  return w.join(' ');
};

async function crossref(filter, limit = 20000) {
  const out = [];
  let cursor = '*';
  while (out.length < limit) {
    const u = `https://api.crossref.org/works?filter=${filter}&rows=1000&cursor=${encodeURIComponent(cursor)}&select=DOI,title,abstract,created,container-title,URL,type`;
    const j = await fetchJson(u);
    if (!j || !j.message || !j.message.items.length) break;
    out.push(...j.message.items);
    cursor = j.message['next-cursor'];
    if (j.message.items.length < 1000) break;
    await sleep(300);
  }
  return out;
}
async function openalex(issn, since) {
  const out = [];
  let cursor = '*';
  while (cursor) {
    const u = `https://api.openalex.org/works?filter=primary_location.source.issn:${issn},from_publication_date:${since}&per-page=200&cursor=${encodeURIComponent(cursor)}&select=doi,title,publication_date,abstract_inverted_index`;
    const j = await fetchJson(u);
    if (!j || !j.results) break;
    out.push(...j.results);
    cursor = j.results.length ? j.meta.next_cursor : null;
    await sleep(150);
  }
  return out;
}

async function repecIndex(code) {
  const t = await fetchText(`https://ideas.repec.org/s/${code.includes('/') ? code : 'eee/' + code}.html`);
  const m = new Map();
  if (!t) return m;
  for (const x of t.matchAll(/<A HREF="(\/a\/[^"]+)">([^<]+)<\/A>/gi)) m.set(norm(strip(x[2])), x[1]);
  return m;
}
async function repecAbstract(href, cache) {
  if (cache[href] !== undefined) return cache[href];
  await sleep(1200);
  const t = await fetchText('https://ideas.repec.org' + href);
  if (!t) return '';
  const m = t.match(/<div id="abstract-body"[^>]*>([\s\S]*?)<\/div>/i) || t.match(/<meta name="citation_abstract" content="([^"]*)"/i);
  const a = m ? strip(m[1]) : '';
  cache[href] = /no abstract is available/i.test(a) ? '' : a;
  return cache[href];
}

function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<(?:rss:)?(item|entry)[ >][\s\S]*?<\/(?:rss:)?\1>/g)].map(m => m[0]);
  const tag = (b, re) => (b.match(re) || [])[1] || '';
  return blocks.map(b => ({
    source,
    title: strip(tag(b, /<(?:rss:)?title[^>]*>([\s\S]*?)<\/(?:rss:)?title>/)),
    abstract: strip(tag(b, /<(?:rss:)?description[^>]*>([\s\S]*?)<\/(?:rss:)?description>/) || tag(b, /<summary[^>]*>([\s\S]*?)<\/summary>/)),
    url: strip(tag(b, /<(?:rss:)?link>([\s\S]*?)<\/(?:rss:)?link>/) || tag(b, /<id>([\s\S]*?)<\/id>/) || tag(b, /<guid[^>]*>([\s\S]*?)<\/guid>/) || tag(b, /rdf:about="([^"]+)"/)),
    date: strip(tag(b, /<(?:dc:date|published|pubDate|updated)>([\s\S]*?)<\/(?:dc:date|published|pubDate|updated)>/)),
  })).filter(p => p.title);
}

async function collect() {
  const papers = [];
  const stats = {};
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  for (const [name, issn, repec] of JOURNALS) {
    if (ONLY_TOP5 && !TOP5.has(name)) continue;
    const since = TOP5.has(name) ? T5_SINCE : SINCE;
    const byDoi = new Map();
    const cr = await crossref(`issn:${issn},from-created-date:${since}`);
    for (const x of cr) {
      if (x.type && x.type !== 'journal-article') continue;
      byDoi.set(x.DOI.toLowerCase(), { source: name, doi: x.DOI, title: strip((x.title || [])[0]), abstract: strip(x.abstract), url: x.URL, date: (x.created || {})['date-time'] || '' });
    }
    for (const x of await openalex(issn, since)) {
      const doi = (x.doi || '').replace('https://doi.org/', '').toLowerCase();
      if (!doi) continue;
      const e = byDoi.get(doi);
      const a = invert(x.abstract_inverted_index);
      if (e) { if (!e.abstract) e.abstract = a; } else byDoi.set(doi, { source: name, doi, title: strip(x.title), abstract: a, url: 'https://doi.org/' + doi, date: x.publication_date });
    }
    const list = [...byDoi.values()].filter(p => p.title && !/^(editorial board|issue information|front ?matter|back ?matter|table of contents|erratum|corrigendum|report of|annual report|notice|forthcoming papers|recent referees|submission|editors?'? ?report|fellows of|election of|acknowledg|volume information|minutes of|the econometric society)/i.test(p.title));
    if (repec) {
      const idx = await repecIndex(repec);
      for (const p of list) {
        if (p.abstract) continue;
        const href = idx.get(norm(p.title));
        if (href) { p.abstract = await repecAbstract(href, cache); p.abstractFrom = 'RePEc'; }
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
    stats[name] = { n: list.length, abs: list.filter(p => p.abstract).length };
    papers.push(...list);
    console.error(name, stats[name]);
  }
  if (ONLY_TOP5) return { papers, stats };
  const ss = await crossref(`prefix:10.2139,from-created-date:${SSRN_SINCE}`, 60000);
  const ssrn = ss.map(x => ({ source: 'SSRN', doi: x.DOI, title: strip((x.title || [])[0]), abstract: strip(x.abstract), url: 'https://doi.org/' + x.DOI, date: (x.created || {})['date-time'] || '' })).filter(p => p.title);
  stats.SSRN = { n: ssrn.length, abs: ssrn.filter(p => p.abstract).length };
  papers.push(...ssrn);
  console.error('SSRN', stats.SSRN);
  for (const [name, url] of RSS_SOURCES) {
    const t = await fetchText(url);
    const items = t ? parseFeed(t, name) : [];
    stats[name] = { n: items.length, abs: items.filter(p => p.abstract.length > 200).length };
    papers.push(...items);
  }
  return { papers, stats };
}

// ---------- 输出 ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function rss(title, desc, items) {
  const body = items.map(p => {
    const snippet = p.abstract ? (p.abstract.length > 300 ? p.abstract.slice(0, 300) + '…' : p.abstract) : '暂无摘要，等摘要入库后会重新判定。';
    const html = `<p><b>期刊/来源：</b>${esc(p.source)}${p.topics.length ? `　<b>主题：</b>${esc(p.topics.join('、'))}` : ''}${p.evidence.length ? `　<b>判定依据：</b>${esc(p.evidence.join('、'))}` : ''}</p><p>${esc(snippet)}</p>`;
    const d = new Date(p.date);
    const mark = p.label && (p.label !== '待判定' || p.showPending) ? `[${p.label}]` : '';
    return `<item><title>${esc(`${mark}[${p.source}] ${p.title}`)}</title><link>${esc(p.url)}</link><guid isPermaLink="false">${esc(p.doi || p.url || p.title)}</guid>${isNaN(d) ? '' : `<pubDate>${d.toUTCString()}</pubDate>`}<description>${esc(html)}</description></item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(title)}</title><description>${esc(desc)}</description><link>https://www.inoreader.com/</link>\n${body}\n</channel></rss>\n`;
}

(async () => {
  const raw = args['from-raw'] ? JSON.parse(fs.readFileSync(args['from-raw'], 'utf8')) : await collect();
  const { papers, stats } = raw;
  if (args['save-raw']) fs.writeFileSync(args['save-raw'], JSON.stringify(raw));
  const seen = new Set();
  const bins = { A: [], B: [], C: [] };
  const top5 = { A: [], B: [] };
  for (const p of papers) {
    const k = norm(p.title);
    if (seen.has(k)) continue;
    seen.add(k);
    const c = classify(p);
    if (TOP5.has(p.source)) {
      const t = classifyTop5(p);
      top5[t.bin].push({ ...p, ...t, topics: c ? c.topics : [] });
    }
    // Top 5 回看一年，但主题订阅 A/B/C 仍用原来的时间窗口
    if (c && (!TOP5.has(p.source) || String(p.date).slice(0, 10) >= SINCE)) bins[c.bin].push({ ...p, ...c });
  }
  for (const b of [...Object.values(bins), ...Object.values(top5)]) b.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'A-game-theory.xml'), rss('A 重点：主题相关 + 博弈论', '数据经济、平台经济、供应链、人工智能主题中使用博弈论方法的论文；标题带[疑似]的是摘要未明说、但看起来是理论模型的论文', bins.A.slice(0, 500)));
  fs.writeFileSync(path.join(OUT, 'B-related-non-game.xml'), rss('B 参考：主题相关 · 未用博弈论', '主题相关但摘要中未见博弈论方法的论文', bins.B.slice(0, 500)));
  fs.writeFileSync(path.join(OUT, 'C-pending.xml'), rss('C 待判定：暂无摘要', '标题主题相关但还没有摘要，暂时无法判断方法；摘要入库后会移到 A 或 B', bins.C.slice(0, 300)));
  fs.writeFileSync(path.join(OUT, 'T5-game-theory.xml'), rss('T5 重点：经济学 Top 5 · 博弈论', 'AER、Econometrica、JPE、QJE、RES 中使用博弈论方法的论文，不限主题；标题带[疑似]的是摘要未明说、但看起来是理论模型的论文', top5.A.slice(0, 300)));
  fs.writeFileSync(path.join(OUT, 'T5-other.xml'), rss('T5 其他：经济学 Top 5 · 其余论文', 'AER、Econometrica、JPE、QJE、RES 中摘要未见博弈论方法的论文；标题带[待判定]的是暂无摘要的论文', top5.B.slice(0, 500)));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ since: SINCE, ssrnSince: SSRN_SINCE, stats, bins, top5 }, null, 1));
  console.log(JSON.stringify({ A: bins.A.length, B: bins.B.length, C: bins.C.length, T5A: top5.A.length, T5B: top5.B.length, total: seen.size }));
  console.log(JSON.stringify(stats));
})();
