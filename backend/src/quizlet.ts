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

        // 2. Try __NEXT_DATA__ if not enough terms
        if (terms.length <= 15) {
            const nextDataScript = $('script#__NEXT_DATA__').html()
            if (nextDataScript) {
                try {
                    const nextData = JSON.parse(nextDataScript)
                    
                    const findTerms = (obj: any) => {
                        if (!obj || typeof obj !== 'object') return
                        
                        if (obj.wordSide && obj.definitionSide) {
                            const termText = obj.wordSide.media?.find((m: any) => m.type === 1)?.plainText || ''
                            const defText = obj.definitionSide.media?.find((m: any) => m.type === 1)?.plainText || ''
                            
                            if (termText || defText) {
                                if (!terms.some((t: any) => t.term === termText && t.definition === defText)) {
                                    terms.push({ term: termText, definition: defText })
                                }
                            }
                        } else if (Array.isArray(obj.cardSides) && obj.cardSides.length >= 2) {
                            const wordSide = obj.cardSides.find((s: any) => s.label === 'word') || obj.cardSides[0]
                            const defSide = obj.cardSides.find((s: any) => s.label === 'definition') || obj.cardSides[1]
                            
                            const termText = wordSide.media?.[0]?.plainText || ''
                            const defText = defSide.media?.[0]?.plainText || ''
                            
                            if (termText || defText) {
                                if (!terms.some((t: any) => t.term === termText && t.definition === defText)) {
                                    terms.push({ term: termText, definition: defText })
                                }
                            }
                        }

                        for (const key in obj) {
                            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                                if (typeof obj[key] === 'object') {
                                    findTerms(obj[key])
                                } else if (typeof obj[key] === 'string' && obj[key].startsWith('{') && (obj[key].includes('wordSide') || obj[key].includes('cardSides') || obj[key].includes('studiableItems'))) {
                                    try { findTerms(JSON.parse(obj[key])) } catch (e) {}
                                }
                            }
                        }
                    }
                    
                    findTerms(nextData)
                } catch (e) {
                    console.error('Error parsing __NEXT_DATA__:', e)
                }
            }
        }

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

function wait(min: number, max: number) {
    const ms = Math.floor(Math.random() * (max - min + 1) + min)
    return new Promise(resolve => setTimeout(resolve, ms))
}

export async function scrapeFolder(url: string, userId: number, onProgress?: (msg: string) => Promise<void>): Promise<TScrapeResult & { setsCount?: number, totalWords?: number, failedCount?: number }> {
    console.log(`[Quizlet API] Scraping folder: ${url}`)
    if (onProgress) await onProgress(`🔍 Fetching folder information...`)

    try {
        const html = await fetchProtectedUrl(url)
        const $ = cheerio.load(html)
        
        let folderName = $('h1').text().trim() || 'Quizlet Folder'
        let setUrls: string[] = []

        // 1. Try Next.js Data
        const nextDataScript = $('#__NEXT_DATA__').html()
        if (nextDataScript) {
            try {
                const json = JSON.parse(nextDataScript)
                const findUrl = (obj: any) => {
                    if (!obj) return
                    if (typeof obj === 'object') {
                        if (obj.studyMaterialId) {
                            setUrls.push(`https://quizlet.com/ua/${obj.studyMaterialId}/`)
                        }
                        Object.values(obj).forEach(findUrl)
                    }
                }
                findUrl(json)
            } catch (e) {
                console.error('Error parsing Next.js data for folder:', e)
            }
        }

        // Extract Links (Fallback)
        const selectors = [
            '[data-testid="content-list-item-card"] a',
            '.SetPreviewCard-header a',
            'a[href*="/flash-cards/"]',
            'a[href*="/learn/"]'
        ]

        selectors.forEach(sel => {
            $(sel).each((_: number, el: any) => {
                const href = $(el).attr('href')
                if (href && (href.includes('/flash-cards/') || /\/\d+\//.test(href))) {
                    setUrls.push(href.startsWith('http') ? href : `https://quizlet.com${href}`)
                }
            })
        })

        setUrls = [...new Set(setUrls)]
        console.log(`[Quizlet API] Found ${setUrls.length} sets in folder.`)

        if (setUrls.length === 0) {
            return { success: false, error: 'No sets found in folder. Check Quizlet.' }
        }

        let totalWords = 0
        let setsScraped = 0
        let failedCount = 0

        for (let i = 0; i < setUrls.length; i++) {
            const setUrl = setUrls[i] as string
            
            if (onProgress) {
                const progress = Math.round((i / setUrls.length) * 10)
                const bar = '🟩'.repeat(progress) + '⬜'.repeat(10 - progress)
                await onProgress(`📁 Syncing "${folderName}"\n\n${bar}\n📈 Progress: ${i} / ${setUrls.length} sets`)
            }

            // Scrape Set
            const result = await scrapeSet(setUrl, userId)
            if (result.success) {
                if (result.count) {
                    totalWords += result.count
                    setsScraped++
                }
            } else {
                failedCount++
            }
            await wait(1000, 3000)
        }

        if (onProgress) {
            await onProgress(`✅ **Folder Sync Complete!**\nAdded ${setsScraped} sets with ${totalWords} total words.`)
        }

        return { success: true, count: totalWords, setsCount: setsScraped, totalWords, failedCount, title: folderName }
    } catch (error: any) {
        console.error('[Quizlet API] Folder Error:', error)
        return { success: false, error: `Failed to scrape folder: ${error.message}` }
    }
}
