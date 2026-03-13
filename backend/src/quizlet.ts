import * as cheerio from 'cheerio'
import { prisma } from './prisma'
import { fetchProtectedUrl } from './scraper'

interface IWordPair {
    term: string
    definition: string
}

interface IScrapeSuccess {
    success: true
    count: number
    title: string
    message?: string
}

interface IScrapeError {
    success: false
    error: string
}

type TScrapeResult = IScrapeSuccess | IScrapeError

function getSetIdFromUrl(url: string): string | null {
    const match = url.match(/quizlet\.com\/(?:[a-z]{2}\/)?(\d+)/)
    return match?.[1] ?? null
}

export async function scrapeSet(url: string, userId: number): Promise<TScrapeResult> {
    console.log(`[Quizlet API] Scraping set: ${url}`)

    // 1. Duplicate check
    const setId = getSetIdFromUrl(url)
    if (setId) {
        const existingSet = await prisma.set.findFirst({
            where: {
                OR: [{ quizletId: setId }, { quizletId: url }],
            },
            include: {
                savedBy: { select: { id: true } },
                _count: { select: { words: true } },
            },
        })

        if (existingSet) {
            const isAlreadySaved = existingSet.userId === userId || existingSet.savedBy.some((u: { id: number }) => u.id === userId)

            if (!isAlreadySaved) {
                await prisma.set.update({
                    where: { id: existingSet.id },
                    data: { savedBy: { connect: { id: userId } } },
                })
                return { success: true, count: existingSet._count.words, title: existingSet.title }
            }

            return { success: true, count: 0, title: existingSet.title, message: 'Already exists' }
        }
    }

    // 2. Fetch + parse
    try {
        const html = await fetchProtectedUrl(url)
        const $ = cheerio.load(html)

        let terms: IWordPair[] = []

        // JSON-LD extraction
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const content = $(el).html()
                if (!content) return
                const data = JSON.parse(content)

                const processLdJson = (json: any) => {
                    if (json['@type'] === 'Quiz' && Array.isArray(json.hasPart)) {
                        const extracted = json.hasPart
                            .filter((part: any) => part['@type'] === 'Question' && part.eduQuestionType === 'Flashcard')
                            .map((part: any) => ({
                                term: part.text || '',
                                definition: part.acceptedAnswer?.text || '',
                            }))
                            .filter((t: IWordPair) => t.term || t.definition)

                        if (extracted.length > 0) {
                            terms = terms.concat(extracted)
                        }
                    }
                }

                if (Array.isArray(data)) {
                    data.forEach(processLdJson)
                } else {
                    processLdJson(data)
                }
            } catch {
                // skip malformed JSON-LD
            }
        })

        // DOM fallback
        if (terms.length === 0) {
            const termTexts = $('.TermText')
            if (termTexts.length > 0) {
                for (let i = 0; i < termTexts.length; i += 2) {
                    const term = $(termTexts[i]).text().trim()
                    const def = $(termTexts[i + 1]).text().trim()
                    if (term || def) {
                        terms.push({ term, definition: def })
                    }
                }
            }
        }

        const title = $('h1').first().text().trim() || `Quizlet Set ${setId || 'Unknown'}`

        if (terms.length === 0) {
            return { success: false, error: 'No words found.' }
        }

        // Upsert set
        await prisma.set.upsert({
            where: { quizletId: setId || url },
            update: {
                title,
                updatedAt: new Date(),
                savedBy: { connect: { id: userId } },
            },
            create: {
                quizletId: setId || url,
                title,
                url,
                userId,
                savedBy: { connect: { id: userId } },
            },
        })

        const set = await prisma.set.findUnique({ where: { quizletId: setId || url } })
        if (!set) throw new Error('Set not found after upsert')

        let wordsAdded = 0
        for (const word of terms) {
            await prisma.word.upsert({
                where: { setId_term: { setId: set.id, term: word.term } },
                update: { definition: word.definition },
                create: { term: word.term, definition: word.definition, setId: set.id },
            })
            wordsAdded++
        }

        return { success: true, count: wordsAdded, title }
    } catch (error: any) {
        console.error('[Quizlet API] Error:', error)
        return { success: false, error: `Failed to scrape set: ${error.message}` }
    }
}
