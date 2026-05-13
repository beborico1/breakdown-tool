// Map IPADIC POS tags (kuromoji output) to the 9 category labels the
// renderer styles: noun, verb, particle, adjective, adverb, counter,
// expression, auxiliary, copula.

const PARTICLE_LABELS = {
  'は': 'topic marker',
  'が': 'subject marker',
  'を': 'object marker',
  'に': 'direction/target marker',
  'へ': 'direction marker',
  'で': 'location/means marker',
  'と': 'with / and',
  'も': 'also / too',
  'の': 'possessive / nominalizer',
  'から': 'from',
  'まで': 'until',
  'や': 'and (non-exhaustive)',
  'か': 'question marker',
  'ね': 'sentence-ending (agreement)',
  'よ': 'sentence-ending (emphasis)',
  'な': 'sentence-ending (emphasis)',
  'けど': 'but / however',
  'って': 'quotation / topic',
  'だけ': 'only',
  'しか': 'only (with negative)',
  'でも': 'even / but',
  'こそ': 'emphasis marker',
  'すら': 'even',
  'ほど': 'extent / degree',
  'ば': 'conditional',
  'たり': 'listing actions',
  'ながら': 'while',
  'のに': 'although',
  'ので': 'because',
  'って': 'quotation',
};

const COPULA_FORMS = new Set(['だ', 'です', 'である', 'でし', 'だっ', 'でしょう', 'でしょ']);

export function mapPOS(token) {
  const pos = token.pos || '';
  const detail = token.pos_detail_1 || '';
  const surface = token.surface_form || '';
  const basic = token.basic_form || surface;

  // Copula (だ / です / である)
  if (COPULA_FORMS.has(surface) || COPULA_FORMS.has(basic)) {
    return { type: 'copula', label: 'copula (to be)' };
  }

  // Auxiliary verbs (助動詞)
  if (pos === '助動詞') {
    return { type: 'auxiliary', label: 'auxiliary' };
  }

  // Particles (助詞)
  if (pos === '助詞') {
    const label = PARTICLE_LABELS[surface] || PARTICLE_LABELS[basic] || `particle (${detail || ''})`.trim();
    return { type: 'particle', label };
  }

  // Verbs (動詞)
  if (pos === '動詞') {
    return { type: 'verb', label: null };
  }

  // Adjectives — i-adjectives (形容詞) and na-adjectives appear as 名詞/形容動詞語幹
  if (pos === '形容詞') {
    return { type: 'adjective', label: null };
  }
  if (pos === '名詞' && detail === '形容動詞語幹') {
    return { type: 'adjective', label: null };
  }

  // Adverbs (副詞)
  if (pos === '副詞') {
    return { type: 'adverb', label: null };
  }

  // Counters (助数詞) — appear as 名詞 with pos_detail_1 = 数 or pos_detail_2 = 助数詞
  if (pos === '名詞' && (detail === '数' || token.pos_detail_2 === '助数詞')) {
    return { type: 'counter', label: null };
  }

  // Interjections / conjunctions / fillers → expression
  if (pos === '感動詞' || pos === '接続詞' || pos === 'フィラー') {
    return { type: 'expression', label: null };
  }

  // Nouns (名詞) and everything else default to noun
  if (pos === '名詞' || pos === '接頭詞' || pos === '連体詞') {
    return { type: 'noun', label: null };
  }

  return { type: 'noun', label: null };
}
