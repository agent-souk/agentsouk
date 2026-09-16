import { fence, Llm, LlmDeclined, MODEL, UNTRUSTED_NOTE } from '../llm.js'
import { baseRates, largestInScope, loadCorpus, precedents, scopeOf, vocabulary, type BaseRates, type Corpus, type Match, type Precedent } from '../corpus.js'
import type { ServiceDef } from './types.js'

/**
 * ADR-76: the thirteenth service, and the first one that answers from something this seller HOLDS rather than
 * from the buyer's own input.
 *
 * Why this and not a fourteenth cent-priced utility: measured in ADR-75, Coinbase's catalogue holds 15,755
 * resources and every capability we offer competes with hundreds of look-alikes, because the capability belongs
 * to the model and anyone can rent it. Nothing we had built could cost more than a few cents for that reason. An
 * agent does not buy "extract JSON" - it can do that itself. It buys the thing it would otherwise have to BUILD:
 * a normalised body of history, a taxonomy, base rates over the right subset, ranked precedent. That takes a day
 * of work and a corpus. We do it once; the buyer pays 0.35 USDC and gets it in half a minute.
 *
 * WHAT THIS IS NOT: it is not a resale of facts. The facts are public and free - DefiLlama publishes that JSON to
 * anyone, and the listing says so in its own words. What is sold is the engine on top: mapping a situation
 * described in WORDS onto a 13/80/17-value taxonomy, the scope that follows from it, the arithmetic over that
 * scope, and the precedent rows with the reason each is there. A buyer can re-check every number against the
 * incident ids we return, which is the point: the answer is auditable, so it can be trusted enough to act on.
 *
 * WHERE THE MODEL IS AND IS NOT: one call maps words onto the vocabulary, with the corpus's own values as an enum
 * in the constrained decoder, so a value no row carries cannot come back. A second call writes the findings, and
 * every finding must cite incident ids from the rows we supplied; ids we cannot find are dropped and the finding
 * is delivered with `grounded: false` rather than hidden (the same discipline as `evidence_verbatim` in ADR-75).
 * Every count, share, median, percentile and trend in between is arithmetic, not a model judgement.
 */

const MIN_SITUATION = 40
const MAX_SITUATION = 4_000
const MAX_CHAIN_HINTS = 5
export const PRICE = 350_000
const CLOSEST = 12
const LARGEST = 6
/**
 * Measured, not guessed. The first live run cancelled on `max_tokens` at 1,600 for the findings call, because the
 * allowance has to cover the thinking the model does by default as well as the JSON. Re-run with room: the two
 * calls together spent 0.0961 USD and produced nine findings with two-sentence reasons. These figures leave that
 * run about a third of headroom, and the worst case they allow is 0.141 USD against a price of 0.35 - factor 2.5,
 * with ADR-72's rule being that no case falls under 1.
 */
const MAP_TOKENS = 1_200
const BRIEF_TOKENS = 3_500
const MAX_FINDINGS = 6
/**
 * How much of the day's model budget this service leaves for everything else, as a SHARE of that budget.
 *
 * It is the most expensive job this seller offers - two calls, about 0.09 USD measured, against 0.03 for the next
 * one - and the daily budget is SHARED across all model-backed services. Without a reserve, roughly fifty of
 * these jobs would close the live budget and with it `extract-structured`, which is the service the only paying
 * buyer actually uses. A delivery also happens before settlement, so an unpaid job costs us the model time
 * either way; that exposure is bounded by the platform's x402 rate limit and by this reserve, and by nothing else.
 *
 * It was a flat 1 USD first, and the sandbox purchase proved that wrong within a minute: the sandbox budget IS
 * 1 USD, so the reserve swallowed it whole and the service declined every job there with "capacity used up" on a
 * completely fresh day. A guard has to scale with what it guards.
 */
const BUDGET_RESERVE_SHARE = 0.2
/**
 * Every array bound below is enforced HERE, in code, not by the schema. `minItems` and `maxItems` are stripped
 * before the schema reaches the constrained decoder (llm.ts: the API rejects them, so callers validate them
 * themselves) - and the first live run proved it by returning nine findings against a `maxItems: 8`. That is not
 * cosmetic: an unbounded findings array is unbounded output tokens, and an unbounded mapping is worse. A model
 * that answered with all 13 classifications would have made the scope the entire corpus and every base rate
 * 100%, which is a confident, worthless answer at 0.35 USDC.
 */
const MAX_CLASSIFICATIONS = 4
const MAX_TECHNIQUES = 6

/**
 * What the corpus cannot tell anyone, delivered with every answer as fixed text rather than left for the buyer to
 * work out. Each line is a real property of incident data, and the first one is the one that matters most: a
 * count of incidents is not a probability, because no incident dataset holds the protocols that were never hit.
 * A service that sells base rates and stays quiet about the missing denominator is selling a false precision.
 */
export const LIMITS = [
  'These are counts of recorded incidents, not probabilities. The corpus has no denominator - it holds the protocols that were hit, never the ones that were not - so "159 oracle-manipulation incidents" is a frequency in the record, not a risk per protocol.',
  'The classification and technique of each row are the source\'s judgement, not a measurement, and one mechanism can honestly sit under two labels. Group on the vocabulary; do not read agreement into it.',
  'Amounts are as first reported in USD at the time, not revised, not inflation-adjusted, and 49 of the rows carry no amount at all - they are counted but cannot be summed.',
  'The most recent weeks of any incident dataset are still filling in, so the newest window undercounts. The corpus states when it was built; the trend counts back from its newest incident, not from today.',
  'Absence is not evidence: a mechanism with no rows here may be new, may be rare, or may simply not have been attributed this way by the source.',
]

const MAP_SYSTEM: string = `You work inside an automated service that answers questions about the history of DeFi and smart-contract incidents from a fixed corpus. Your ONLY job in this call is to map the customer's situation onto that corpus's vocabulary. ${UNTRUSTED_NOTE}
Choose at most ${MAX_CLASSIFICATIONS} classifications and at most ${MAX_TECHNIQUES} techniques under which incidents like the one described would have been recorded - the mechanisms that this situation is exposed to, not the ones it merely mentions. Prefer the narrow value: a technique says what happened, a classification says which drawer it goes in, and a technique that fits is worth more than three classifications that nearly fit. Breadth costs the customer the answer - a mapping onto everything makes the base rate the whole corpus, which says nothing. Choose the target type that matches what the customer is building or reviewing, and list only chains the situation actually names or clearly implies.
Put a one-sentence reading of the situation in \`reading\`, in your own words, so the customer can see what was understood before any number is computed.
If the situation is not about a smart contract, protocol, bridge, exchange, wallet, token or comparable on-chain system at all, leave the lists empty and say so in \`out_of_scope\`. Do not stretch to a match: an answer built on a wrong mapping is worse than no answer, and a job with \`out_of_scope\` set is cancelled and never charged.`

const BRIEF_SYSTEM: string = `You work inside an automated service that answers questions about DeFi incident history. The mapping and the arithmetic are already done: below you get the customer's situation, how it was mapped onto the corpus vocabulary, the computed base rates, and the incident rows that were selected as precedent. ${UNTRUSTED_NOTE}
Write at most ${MAX_FINDINGS} findings that a reviewer of this situation should take away. Each finding is one sentence that says something actionable, \`because\` gives the evidence in at most two sentences, and \`precedent_ids\` lists the ids of the incident rows below that it rests on - only ids that appear below, never an id you construct. Every finding must rest on at least one row or on a figure from the base rates.
Work only from what is given. Never add an incident, protocol, amount or date that is not in the rows below, never estimate a probability the data cannot support - these are counts of recorded incidents with no denominator - and never repeat a number without the count it came from. Where the rows point at a concrete check the customer can run, say the check, not the platitude. Order the findings by what would cost the most if ignored.`

const CHAIN_HINT_MAX = 40
/**
 * The decoder rejects a field declared `['string', 'null']` whose enum holds strings ("Enum value 'DeFi Protocol'
 * does not match declared type", real 400 on the first live run), so "the situation names no target type" needs a
 * value of its own inside the alphabet rather than a null beside it. It cannot collide with a corpus value; the
 * corpus's own catch-all is called "Other", which means something different and stays available.
 */
const NO_TARGET = 'unspecified'

/** The mapping the decoder is given. The enums come from the corpus itself, so a value no row carries cannot be returned. */
function mapSchema(c: Corpus) {
  const v = vocabulary(c)
  return {
    type: 'object',
    required: ['reading', 'classifications', 'techniques', 'target_type', 'chains', 'out_of_scope'],
    additionalProperties: false,
    properties: {
      reading: { type: 'string', description: 'one sentence: what you understood the situation to be' },
      // maxItems is dropped on the way to the decoder; the count is capped in run(), and the prompt asks anyway
      classifications: { type: 'array', items: { type: 'string', enum: v.classifications } },
      techniques: { type: 'array', items: { type: 'string', enum: v.techniques } },
      target_type: { type: 'string', enum: [...v.target_types, NO_TARGET], description: `the target type this situation is, or "${NO_TARGET}" when the situation does not say` },
      chains: { type: 'array', items: { type: 'string', enum: v.chains } },
      out_of_scope: { type: ['string', 'null'], description: 'set only when the situation is not about an on-chain system at all' },
    },
  }
}

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding', 'because', 'precedent_ids'],
        additionalProperties: false,
        properties: {
          finding: { type: 'string' },
          because: { type: 'string' },
          precedent_ids: { type: 'array', items: { type: 'string' }, description: 'ids of the supplied incident rows this rests on' },
        },
      },
    },
  },
}

/** The precedent row as it is delivered: the facts, plus why this row is here at all. */
export type DeliveredPrecedent = {
  id: string
  date: string
  protocol: string
  amount_usd: number | null
  returned_usd: number | null
  chains: string[]
  classification: string | null
  technique: string | null
  target_type: string | null
  bridge: boolean
  relevance: number
  matched_on: string[]
}
const deliver = (p: Precedent): DeliveredPrecedent => ({
  id: p.id,
  date: p.date,
  protocol: p.protocol,
  amount_usd: p.amount_usd,
  returned_usd: p.returned_usd,
  chains: p.chains,
  classification: p.classification,
  technique: p.technique,
  target_type: p.target_type,
  bridge: p.bridge,
  relevance: p.score,
  matched_on: p.matched_on,
})

const PRECEDENT_ITEM = {
  type: 'object',
  required: ['id', 'date', 'protocol', 'amount_usd', 'chains', 'classification', 'technique', 'target_type', 'bridge', 'relevance', 'matched_on'],
  properties: {
    id: { type: 'string', description: 'stable handle for this incident in the corpus; cite it back when you want the same row' },
    date: { type: 'string' },
    protocol: { type: 'string' },
    amount_usd: { type: ['number', 'null'], description: 'null where the source states no amount' },
    returned_usd: { type: ['number', 'null'] },
    chains: { type: 'array', items: { type: 'string' } },
    classification: { type: ['string', 'null'] },
    technique: { type: ['string', 'null'] },
    target_type: { type: ['string', 'null'] },
    bridge: { type: 'boolean' },
    relevance: { type: 'integer', description: `score: technique 4, classification 3, target type 1, chain 1` },
    matched_on: { type: 'array', items: { type: 'string' }, description: 'exactly which fields put this row here' },
  },
}
const LOSS = {
  type: 'object',
  properties: {
    with_amount: { type: 'integer' },
    total_usd: { type: 'integer' },
    median_usd: { type: ['integer', 'null'] },
    p90_usd: { type: ['integer', 'null'] },
    max_usd: { type: ['integer', 'null'] },
    mean_usd: { type: ['integer', 'null'] },
  },
}
const COUNTS = { type: 'array', items: { type: 'object', required: ['value', 'incidents', 'total_usd'], properties: { value: { type: 'string' }, incidents: { type: 'integer' }, total_usd: { type: 'integer' } } } }

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['reading', 'match', 'base_rates', 'precedents', 'findings', 'limits', 'corpus', 'model'],
  properties: {
    reading: { type: 'string' },
    match: {
      type: 'object',
      required: ['classifications', 'techniques', 'target_type', 'chains'],
      properties: {
        classifications: { type: 'array', items: { type: 'string' } },
        techniques: { type: 'array', items: { type: 'string' } },
        target_type: { type: ['string', 'null'] },
        chains: { type: 'array', items: { type: 'string' } },
        chains_unmatched: { type: 'array', items: { type: 'string' }, description: 'chain names you sent that no incident in the corpus carries; dropped from the scope rather than silently honoured' },
      },
    },
    base_rates: {
      type: 'object',
      required: ['scope', 'narrowed', 'by_mechanism', 'by_classification', 'by_technique', 'by_chain', 'by_target_type', 'by_year', 'trend', 'returned_usd'],
      properties: {
        scope: { type: 'object', required: ['definition', 'incidents', 'share_of_corpus_pct', 'loss'], properties: { definition: { type: 'string' }, incidents: { type: 'integer' }, share_of_corpus_pct: { type: 'number' }, loss: LOSS } },
        narrowed: { type: ['object', 'null'], description: 'the same scope restricted to the chain and target type of the situation; null when the situation named neither' },
        by_mechanism: {
          type: 'array',
          description: 'one base rate per matched mechanism, largest first - the figures to use. The single scope figure is the union of these and is only context: a situation that maps onto several mechanisms has a union that can reach half the corpus, which says nothing.',
          items: {
            type: 'object',
            required: ['value', 'kind', 'incidents', 'share_of_corpus_pct', 'loss', 'narrowed_incidents', 'recent_12m', 'previous_12m', 'change_pct', 'excess_pct'],
            properties: {
              value: { type: 'string' },
              kind: { type: 'string', enum: ['classification', 'technique'] },
              incidents: { type: 'integer' },
              share_of_corpus_pct: { type: 'number' },
              loss: LOSS,
              narrowed_incidents: { type: ['integer', 'null'], description: 'the same mechanism on your chain and target type; null when your situation named neither' },
              recent_12m: { type: 'integer' },
              previous_12m: { type: 'integer' },
              change_pct: { type: ['integer', 'null'] },
              excess_pct: { type: ['integer', 'null'], description: 'change_pct minus the corpus-wide change: the part that is about this mechanism' },
            },
          },
        },
        by_classification: COUNTS,
        by_technique: COUNTS,
        by_chain: COUNTS,
        by_target_type: COUNTS,
        by_year: COUNTS,
        trend: {
          type: 'object',
          required: ['recent', 'previous', 'change_pct', 'corpus_change_pct', 'excess_pct'],
          properties: {
            recent: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, incidents: { type: 'integer' }, loss: LOSS } },
            previous: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, incidents: { type: 'integer' }, loss: LOSS } },
            change_pct: { type: ['integer', 'null'], description: 'change in incident count, this scope, two equal twelve-month windows' },
            corpus_change_pct: { type: ['integer', 'null'], description: 'the same change across the whole corpus' },
            excess_pct: { type: ['integer', 'null'], description: 'change_pct minus corpus_change_pct: the part that is about this scope rather than about the dataset growing' },
          },
        },
        returned_usd: { type: 'integer', description: 'how much of this scope was ever recovered' },
      },
    },
    precedents: {
      type: 'object',
      required: ['closest', 'largest'],
      properties: {
        closest: { type: 'array', items: PRECEDENT_ITEM, description: 'ranked by relevance; ties break newest first' },
        largest: { type: 'array', items: PRECEDENT_ITEM, description: 'the biggest losses inside the same scope - the tail, which relevance ranking hides' },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding', 'because', 'precedent_ids', 'grounded'],
        properties: {
          finding: { type: 'string' },
          because: { type: 'string' },
          precedent_ids: { type: 'array', items: { type: 'string' }, description: 'ids from precedents, checked against the delivered rows; anything else is removed' },
          grounded: { type: 'boolean', description: 'true when at least one cited id was found among the delivered rows' },
        },
      },
    },
    limits: { type: 'array', items: { type: 'string' }, description: 'what this corpus cannot tell you; the same five lines with every answer' },
    corpus: { type: 'object', required: ['built_at', 'incidents', 'source_name', 'source_url'], properties: { built_at: { type: 'string' }, incidents: { type: 'integer' }, source_name: { type: 'string' }, source_url: { type: 'string' } } },
    model: { type: 'string' },
  },
}

/** What the brief call sees of a row: enough to reason about, short enough that eighteen of them stay cheap. */
const compact = (p: DeliveredPrecedent) =>
  `${p.id} | ${p.date} | ${p.protocol} | ${p.amount_usd == null ? 'amount unstated' : `${p.amount_usd} USD`}${p.returned_usd ? ` (${p.returned_usd} returned)` : ''} | ${p.classification ?? '-'} / ${p.technique ?? '-'} | ${p.target_type ?? '-'} | ${p.chains.join(', ') || '-'}${p.bridge ? ' | bridge' : ''}`

function briefInput(situation: string, m: Match, rates: BaseRates, rows: DeliveredPrecedent[]): string {
  const s = rates.scope
  const lines = [
    `Situation, as the customer wrote it:\n${fence(situation)}`,
    `Mapped onto the corpus as: classifications [${m.classifications.join(', ') || 'none'}], techniques [${m.techniques.join(', ') || 'none'}], target type ${m.target_type ?? 'unspecified'}, chains [${m.chains.join(', ') || 'unspecified'}].`,
    `Base rates over that scope: ${s.incidents} recorded incidents (${s.share_of_corpus_pct}% of the corpus), ${s.loss.with_amount} with a stated amount, median ${s.loss.median_usd} USD, p90 ${s.loss.p90_usd} USD, largest ${s.loss.max_usd} USD, total ${s.loss.total_usd} USD, of which ${rates.returned_usd} USD was recovered.`,
    rates.narrowed ? `Restricted to ${rates.narrowed.definition}: ${rates.narrowed.incidents} incidents, median ${rates.narrowed.loss.median_usd} USD, largest ${rates.narrowed.loss.max_usd} USD.` : '',
    `One base rate per mechanism - USE THESE, not the union above, which is only context:\n${rates.by_mechanism
      .map(
        (x) =>
          `- ${x.value} (${x.kind}): ${x.incidents} incidents, ${x.share_of_corpus_pct}% of the corpus, median ${x.loss.median_usd} USD, p90 ${x.loss.p90_usd} USD, largest ${x.loss.max_usd} USD${x.narrowed_incidents == null ? '' : `, ${x.narrowed_incidents} of them on the customer's chain and target type`}; ${x.recent_12m} in the last twelve months against ${x.previous_12m} before (${x.change_pct}%, ${x.excess_pct}% beyond how the whole corpus moved)`,
      )
      .join('\n')}`,
    `Trend, two equal twelve-month windows: ${rates.trend.recent.incidents} incidents in ${rates.trend.recent.from}..${rates.trend.recent.to} against ${rates.trend.previous.incidents} in the twelve months before (${rates.trend.change_pct}%), while the whole corpus changed by ${rates.trend.corpus_change_pct}% over the same windows - so the part specific to this scope is ${rates.trend.excess_pct}%.`,
    `Concentration inside the scope - technique: ${rates.by_technique.map((t) => `${t.value} ${t.incidents}`).join('; ')}. Chain: ${rates.by_chain.map((t) => `${t.value} ${t.incidents}`).join('; ')}. Target type: ${rates.by_target_type.map((t) => `${t.value} ${t.incidents}`).join('; ')}. Year: ${rates.by_year.map((t) => `${t.value} ${t.incidents}`).join('; ')}.`,
    `Incident rows, id | date | protocol | loss | classification / technique | target type | chains:\n${rows.map(compact).join('\n')}`,
    `What this data cannot tell anyone - do not write a finding that ignores these:\n${LIMITS.map((l) => `- ${l}`).join('\n')}`,
  ]
  return lines.filter(Boolean).join('\n\n')
}

export function riskPrecedent(llm: Llm, opts: { corpus?: Corpus } = {}): ServiceDef {
  const corpus = () => opts.corpus ?? loadCorpus()
  const c = corpus()
  // `years` is ordered by incident count, not by year, so the first entry is the busiest year and not the newest
  const years = c.years.map((a) => a.value).sort()
  const span = { first: years[0] ?? '2011', last: years[years.length - 1] ?? '2026' }

  return {
    key: 'risk-precedent',
    listing: {
      // 120 characters, and a catalogue shows the TITLE as the resource's description (measured in ADR-70)
      title: `Precedent and base rates from ${c.counts.incidents} recorded DeFi incidents: describe your system, get the history it sits in`,
      description: [
        `Send {"situation": "<what you are building, auditing or considering, in words>"} and get the history that situation sits in: which mechanisms it is exposed to, how often incidents like it were actually recorded, what they cost, whether the rate is rising faster than the record as a whole, and the concrete precedents - ${CLOSEST} ranked by relevance plus the ${LARGEST} largest losses in the same scope, each with its incident id so you can cite it back.`,
        `The corpus holds ${c.counts.incidents} incidents from ${span.first} to ${span.last}, ${(c.classifications.reduce((s, a) => s + a.total_usd, 0) / 1e9).toFixed(1)} bn USD of stated losses, normalised into one row shape with ${c.classifications.length} classifications, ${c.techniques.length} techniques, ${c.target_types.length} target types and ${c.chains.length} chains. The facts are public: they come from ${c.source.name} (${c.source.url}), which anyone can fetch for free, and we say so rather than implying private data.`,
        `What you are buying is the engine over them. One model call maps your situation onto the corpus vocabulary, with the corpus's own values as an enum in a constrained decoder, so a label no incident carries cannot come back. Everything you are charged for after that is arithmetic: the scope that follows from the mapping, counts and shares, median, p90, mean and maximum loss, recovery, concentration by technique, chain, target type and year, and two equal twelve-month windows compared against the same windows over the whole corpus - because a corpus that grew from 148 to 264 incidents a year makes almost any scope look like it is rising, and excess_pct is the part that is really about you.`,
        `The mapping is capped at ${MAX_CLASSIFICATIONS} classifications and ${MAX_TECHNIQUES} techniques on purpose: a situation mapped onto everything would make the scope the whole corpus and every base rate 100%, which is a confident answer that says nothing. Where the mapping is broad, read by_technique and by_classification rather than the single scope figure - share_of_corpus_pct tells you how broad it was.`,
        `Then at most ${MAX_FINDINGS} findings: each one cites the incident ids it rests on, we check every id against the rows actually delivered, and a finding whose citations we could not find is delivered with grounded false rather than quietly kept. Every number can be re-checked against the ids in the answer, which is the point - the answer is auditable, not a verdict you have to trust.`,
        'Delivered with every answer: five fixed lines on what this data cannot tell you. The first is the one that matters - these are counts of recorded incidents, not probabilities, because no incident dataset holds the protocols that were never hit. A service that sells base rates without saying that is selling false precision.',
        `A situation that is not about a smart contract, protocol, bridge, exchange, wallet or comparable on-chain system is cancelled rather than answered, so you pay nothing for a mapping that would have been a stretch. Situation between ${MIN_SITUATION} and ${MAX_SITUATION} characters; a fixed price per question, no unit counting.`,
        `Powered by Claude (${MODEL}). The corpus is a build artifact with a stated build time, refreshed as the source publishes; the answer names the build it came from. Operated by Agent Souk (first_party).`,
      ].join(' '),
      category: 'research',
      tags: ['defi', 'security', 'risk', 'base-rates', 'incidents', 'precedent', 'audit', 'due-diligence'],
      price: PRICE,
      input_schema: {
        type: 'object',
        required: ['situation'],
        additionalProperties: false,
        properties: {
          situation: {
            type: 'string',
            minLength: MIN_SITUATION,
            maxLength: MAX_SITUATION,
            description: 'What you are building, auditing or considering, in your own words. The more concretely you name the mechanism - what it holds, what it reads, who can call what - the narrower the scope the mapping can reach.',
          },
          chains: { type: 'array', maxItems: MAX_CHAIN_HINTS, items: { type: 'string', maxLength: CHAIN_HINT_MAX }, description: 'Optional: chains to weigh, e.g. ["Base"]. A name the corpus does not know is reported back as unmatched rather than silently ignored.' },
        },
      },
      output_schema: OUTPUT_SCHEMA,
      example_input: {
        situation: 'An ERC-4626 vault on Base. Depositors mint shares against a single ERC-20 collateral, and the share price is computed from a Uniswap v3 spot quote of that collateral against USDC at the moment of deposit and withdrawal. Rewards are streamed in by a keeper. I want to know what has actually happened to designs like this.',
        chains: ['Base'],
      },
      example_output: {
        reading: 'An ERC-4626 share vault on Base whose share price is derived from a live Uniswap v3 spot quote, with a keeper streaming rewards.',
        match: { classifications: ['Oracle Manipulation', 'Token & Share Accounting'], techniques: ['Spot Price Manipulation', 'Incorrect Share Accounting'], target_type: 'DeFi Protocol', chains: ['Base'], chains_unmatched: [] },
        base_rates: {
          scope: { definition: 'incidents whose classification is one of [Oracle Manipulation, Token & Share Accounting] or whose technique is one of [Spot Price Manipulation, Incorrect Share Accounting]', incidents: 318, share_of_corpus_pct: 25, loss: { with_amount: 306, total_usd: 2338266764, median_usd: 521000, p90_usd: 11539000, max_usd: 223000000, mean_usd: 7641394 } },
          narrowed: { definition: 'the same scope, target type DeFi Protocol and chain in Base', incidents: 10, loss: { with_amount: 10, total_usd: 196243000, median_usd: 1780000, p90_usd: 128000000, max_usd: 128000000, mean_usd: 19624300 } },
          by_mechanism: [
            { value: 'Spot Price Manipulation', kind: 'technique', incidents: 131, share_of_corpus_pct: 10.3, loss: { with_amount: 128, total_usd: 829737392, median_usd: 800000, p90_usd: 11500000, max_usd: 130000000, mean_usd: 6482324 }, narrowed_incidents: 6, recent_12m: 49, previous_12m: 21, change_pct: 133, excess_pct: 48 },
            { value: 'Incorrect Share Accounting', kind: 'technique', incidents: 44, share_of_corpus_pct: 3.5, loss: { with_amount: 42, total_usd: 68357657, median_usd: 212000, p90_usd: 3400000, max_usd: 11000000, mean_usd: 1627563 }, narrowed_incidents: 2, recent_12m: 19, previous_12m: 8, change_pct: 137, excess_pct: 52 },
          ],
          by_classification: [{ value: 'Oracle Manipulation', incidents: 159, total_usd: 888721492 }],
          by_technique: [{ value: 'Spot Price Manipulation', incidents: 131, total_usd: 829737392 }],
          by_chain: [{ value: 'Ethereum', incidents: 108, total_usd: 1218254861 }],
          by_target_type: [{ value: 'DeFi Protocol', incidents: 279, total_usd: 1717442659 }],
          by_year: [{ value: '2026', incidents: 86, total_usd: 316653632 }],
          trend: {
            recent: { from: '2025-09-16', to: '2026-09-16', incidents: 97, loss: { with_amount: 96, total_usd: 465199432, median_usd: 305000, p90_usd: 8700000, max_usd: 128000000, mean_usd: 4845827 } },
            previous: { from: '2024-09-16', to: '2025-09-16', incidents: 44, loss: { with_amount: 44, total_usd: 306167263, median_usd: 450000, p90_usd: 8400000, max_usd: 223000000, mean_usd: 6958347 } },
            change_pct: 120,
            corpus_change_pct: 63,
            excess_pct: 57,
          },
          returned_usd: 253432650,
        },
        precedents: {
          closest: [{ id: '2026-08-27-moonwell-lending', date: '2026-08-27', protocol: 'Moonwell Lending', amount_usd: 8700000, returned_usd: null, chains: ['Base'], classification: 'Oracle Manipulation', technique: 'Spot Price Manipulation', target_type: 'DeFi Protocol', bridge: false, relevance: 9, matched_on: ['technique:Spot Price Manipulation', 'classification:Oracle Manipulation', 'target_type:DeFi Protocol', 'chain:Base'] }],
          largest: [{ id: '2025-04-30-example-lending', date: '2025-04-30', protocol: 'a larger incident in the same scope', amount_usd: 223000000, returned_usd: null, chains: ['Ethereum'], classification: 'Oracle Manipulation', technique: 'Spot Price Manipulation', target_type: 'DeFi Protocol', bridge: false, relevance: 8, matched_on: ['technique:Spot Price Manipulation', 'classification:Oracle Manipulation', 'target_type:DeFi Protocol'] }],
        },
        findings: [
          {
            finding: 'A spot quote read at the moment of deposit and withdrawal is the single most attacked pattern in this corpus: price the share against a time-weighted or multi-source value instead, and reject a deposit whose implied price moved more than a set band within the block.',
            because: 'Spot Price Manipulation is 131 of the 318 incidents in this scope, the largest single technique, and the two most recent Base precedents both took this shape.',
            precedent_ids: ['2026-08-27-moonwell-lending'],
            grounded: true,
          },
        ],
        limits: LIMITS,
        corpus: { built_at: '2026-09-16T22:31:18.019Z', incidents: 1271, source_name: 'DefiLlama hacks', source_url: 'https://api.llama.fi/hacks' },
        model: MODEL,
      },
      turnaround_seconds: 180,
      accept_timeout_seconds: 600,
      max_open_jobs: 10,
    },

    validate(input) {
      const known = ['situation', 'chains']
      const unknown = Object.keys(input).filter((k) => !known.includes(k))
      if (unknown.length) return `unknown field(s): ${unknown.slice(0, 5).join(', ')}. This service takes only ${known.join(', ')}`
      const situation = input.situation
      if (typeof situation !== 'string' || situation.trim().length < MIN_SITUATION) return `situation must be a string of at least ${MIN_SITUATION} characters: describe what you are building, auditing or considering`
      if (situation.length > MAX_SITUATION) return `situation is limited to ${MAX_SITUATION} characters per job`
      if (input.chains !== undefined) {
        if (!Array.isArray(input.chains) || input.chains.length > MAX_CHAIN_HINTS) return `chains must be an array of at most ${MAX_CHAIN_HINTS} chain names`
        if (input.chains.some((ch) => typeof ch !== 'string' || !ch.trim() || ch.length > CHAIN_HINT_MAX)) return `each chain must be a non-empty string of at most ${CHAIN_HINT_MAX} characters`
      }
      // both calls are held for at once: the second one is not optional, and a budget that only covers the first
      // would spend money on a mapping that can never be delivered
      const mapChars = situation.length + MAP_SYSTEM.length + JSON.stringify(vocabulary(corpus())).length
      const briefChars = BRIEF_SYSTEM.length + situation.length + (CLOSEST + LARGEST) * 200 + 2_000
      // the reserve is added to the estimate, so this service stops while the cheaper ones still have a day left
      const reserve = llm.dailyBudgetUsd * BUDGET_RESERVE_SHARE
      return llm.declineReason(Llm.estimateUsd(mapChars, MAP_TOKENS) + Llm.estimateUsd(briefChars, BRIEF_TOKENS) + reserve)
    },

    async run(input) {
      const situation = (input.situation as string).trim()
      const hints = Array.isArray(input.chains) ? (input.chains as string[]).map((s) => s.trim()).filter(Boolean) : []
      const c = corpus()
      const known = vocabulary(c)

      const hintLine = hints.length ? `The customer also named these chains: ${fence(hints.join(', '))}\n\n` : ''
      const mapped = await llm.completeJson<{ reading: string; classifications: string[]; techniques: string[]; target_type: string | null; chains: string[]; out_of_scope: string | null }>({
        system: MAP_SYSTEM,
        user: `${hintLine}Map the situation below onto the corpus vocabulary.\n\n${fence(situation)}`,
        maxTokens: MAP_TOKENS,
        effort: 'medium',
        jsonSchema: mapSchema(c),
        claimHold: true,
      })
      const m0 = mapped.data
      if (!m0 || typeof m0 !== 'object') throw new LlmDeclined('the model did not return a JSON object; retry the job')
      if (m0.out_of_scope) {
        // cancelled, not answered: the buyer pays nothing for a mapping that would have been a stretch. This
        // books publicly as a seller failure (ADR-70), which is the cost we accept - it is cheaper than charging
        // 0.25 USDC for statistics about a scope the situation never sat in.
        throw new LlmDeclined(`this service answers from a corpus of DeFi and smart-contract incidents, and the situation does not sit in it, so the job is cancelled rather than answered with a stretched mapping. The model's reading: ${String(m0.out_of_scope).slice(0, 300)}`)
      }
      const m: Match = {
        classifications: (m0.classifications ?? []).filter((v) => known.classifications.includes(v)).slice(0, MAX_CLASSIFICATIONS),
        techniques: (m0.techniques ?? []).filter((v) => known.techniques.includes(v)).slice(0, MAX_TECHNIQUES),
        target_type: m0.target_type && m0.target_type !== NO_TARGET && known.target_types.includes(m0.target_type) ? m0.target_type : null,
        // a hint the corpus does not know is dropped here and named in the answer, never silently honoured
        chains: [...new Set([...(m0.chains ?? []), ...hints])].filter((v) => known.chains.includes(v)).slice(0, MAX_CHAIN_HINTS),
      }
      if (!m.classifications.length && !m.techniques.length) {
        throw new LlmDeclined('the situation could not be mapped onto any incident class in the corpus, so there is no scope to compute base rates over; the job is cancelled rather than answered from an empty scope. Try naming the mechanism more concretely - what the contract holds, what it reads, and who may call what.')
      }

      const rates = baseRates(c, m)
      const scope = scopeOf(c, m)
      const closest = precedents(c, m, CLOSEST).map(deliver)
      const closestIds = new Set(closest.map((p) => p.id))
      const largest = largestInScope(scope, m, LARGEST + CLOSEST)
        .filter((p) => !closestIds.has(p.id))
        .slice(0, LARGEST)
        .map(deliver)
      const rows = [...closest, ...largest]
      const ids = new Set(rows.map((p) => p.id))

      const brief = await llm.completeJson<{ findings: { finding: string; because: string; precedent_ids: string[] }[] }>({
        system: BRIEF_SYSTEM,
        user: briefInput(situation, m, rates, rows),
        maxTokens: BRIEF_TOKENS,
        effort: 'medium',
        jsonSchema: BRIEF_SCHEMA,
      })
      const rawFindings = brief.data?.findings
      if (!Array.isArray(rawFindings) || !rawFindings.length) throw new LlmDeclined('the model returned no findings; retry the job')
      // every citation is checked against the rows we actually delivered. An id we cannot find is removed rather
      // than passed on as if it were a reference, and the finding says so instead of being dropped: the same
      // discipline as `evidence_verbatim` in ADR-75, for the same reason - a citation nobody checks is decoration.
      const findings = rawFindings.slice(0, MAX_FINDINGS).map((f) => {
        const cited = (f.precedent_ids ?? []).filter((id) => ids.has(id))
        return { finding: f.finding, because: f.because, precedent_ids: cited, grounded: cited.length > 0 }
      })

      const output = {
        reading: m0.reading,
        match: { ...m, chains_unmatched: hints.filter((h) => !known.chains.includes(h)) },
        base_rates: rates,
        precedents: { closest, largest },
        findings,
        limits: LIMITS,
        corpus: { built_at: c.built_at, incidents: c.counts.incidents, source_name: c.source.name, source_url: c.source.url },
        model: mapped.completion.model,
      }
      const grounded = findings.filter((f) => f.grounded).length
      const dates = rows.map((p) => p.date).sort()
      /**
       * The preview and the message are BOTH visible before the buyer pays (`preview` is documented as "a teaser
       * the buyer sees before paying", and a sealed delivery shows it alongside the hash and size). The first
       * version of this service put the whole per-mechanism table in the preview with counts and medians - which
       * is the substance of the answer, given away for nothing. What stays is proof that the work exists and was
       * understood: the reading, how many mechanisms matched, how big the sets are, how many precedents and
       * findings. What leaves is every figure a buyer could act on - no mechanism names, no medians, no ids.
       */
      return {
        output,
        preview: {
          reading: m0.reading,
          mechanisms_matched: rates.by_mechanism.length,
          scope_incidents: rates.scope.incidents,
          scope_share_of_corpus_pct: rates.scope.share_of_corpus_pct,
          narrowed_incidents: rates.narrowed?.incidents ?? null,
          precedents: rows.length,
          precedents_span: rows.length ? { oldest: dates[0], newest: dates[dates.length - 1] } : null,
          findings: findings.length,
          findings_grounded: grounded,
          corpus: { incidents: c.counts.incidents, built_at: c.built_at },
        },
        message: `${rates.by_mechanism.length} mechanism(s) matched your situation; their union is ${rates.scope.incidents} recorded incidents, ${rates.scope.share_of_corpus_pct}% of the corpus${rates.narrowed ? `, and ${rates.narrowed.incidents} of those are ${rates.narrowed.definition.replace('the same scope, ', '')}` : ''}. The answer carries a separate base rate for each mechanism - incidents, share, median, p90, largest, how many are on your chain and target type, and twelve months against the twelve before - plus ${rows.length} precedent incidents with ids you can cite back, and ${findings.length} finding(s), ${grounded} of them citing a row we could confirm. Read by_mechanism rather than the union figure above, which is context only, and read limits: these are counts of recorded incidents, not probabilities.`,
      }
    },
  }
}
