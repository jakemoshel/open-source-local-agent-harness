/** Local sparse-vector retrieval; no API, model or database. */
const STOP_WORDS = new Set('a an and are as at be been but by can could do does for from get has have help how i in into is it its me my of on or our please run should some that the their them then there these they this to use using was we what when where which will with would you your task skill skills tool tools operation operations'.split(' '))
export function words(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP_WORDS.has(w)).map(w => w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))]
}
export interface RetrievalDocument<T> {
  id: string
  value: T
  fields: { terms: Iterable<string>; weight: number }[]
}
const normalizeName = (id: string) => id.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
/** Sparse TF-IDF cosine over an inverted index; only documents sharing a query term are scored. */
export function rankDocuments<T>(query: string, documents: RetrievalDocument<T>[]) {
  const terms = words(query)
  if (!terms.length || !documents.length) return []
  const postings = new Map<string, Map<number, number>>()
  documents.forEach((doc, index) => {
    for (const field of doc.fields) for (const term of new Set(field.terms)) {
      let hits = postings.get(term)
      if (!hits) { hits = new Map(); postings.set(term, hits) }
      hits.set(index, (hits.get(index) ?? 0) + field.weight)
    }
  })
  const q = terms.filter(t => postings.has(t))
  if (!q.length) return []
  const idf = new Map<string, number>(), norms = new Float64Array(documents.length)
  for (const [term, hits] of postings) {
    const weight = Math.log(1 + documents.length / hits.size)
    idf.set(term, weight)
    for (const [index, value] of hits) norms[index] += (value * weight) ** 2
  }
  const qNorm = Math.sqrt(q.reduce((sum, t) => sum + idf.get(t)! ** 2, 0))
  const scores = new Map<number, { dot: number; matched: number }>()
  for (const term of q) {
    const w = idf.get(term)! ** 2
    for (const [i, weight] of postings.get(term)!) {
      const score = scores.get(i) ?? { dot: 0, matched: 0 }
      score.dot += weight * w; score.matched++
      scores.set(i, score)
    }
  }
  const normalizedQuery = ` ${normalizeName(query)} `
  return [...scores].map(([i, hit]) => {
    const doc = documents[i]
    const cosine = hit.dot / (qNorm * Math.sqrt(norms[i]) || 1)
    const exactName = words(doc.id).length > 0 && normalizedQuery.includes(` ${normalizeName(doc.id)} `)
    return { ...doc.value as T & object, score: cosine + (exactName ? 1 : 0), similarity: cosine, matched: hit.matched, exactName, id: doc.id }
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
