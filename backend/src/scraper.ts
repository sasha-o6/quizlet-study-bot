const BRIGHTDATA_API_URL = process.env.BRIGHTDATA_API_URL || ''
const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY || ''
const BRIGHTDATA_API_ZONE = process.env.BRIGHTDATA_API_ZONE || ''

export async function fetchProtectedUrl(url: string): Promise<string> {
    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            zone: BRIGHTDATA_API_ZONE,
            url,
            format: 'json',
        }),
    }

    const request = await fetch(BRIGHTDATA_API_URL, options)
    const response = await request.json() as { status_code: number; body: string }

    if (response.status_code === 200) {
        return String(response.body)
    }

    throw new Error(`[BRIGHTDATA] Failed to fetch protected URL: ${JSON.stringify(response)}`)
}
