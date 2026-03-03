export class ScraperService {

    constructor() {
    }

    async fetchProtectedUrl(url: string): Promise<string> {
        try {
            const targetUrl = url;
            const apiUrl = process.env.BRIGHTDATA_API_URL!;
            const apiKey = process.env.BRIGHTDATA_API_KEY!;
            const apiZone = process.env.BRIGHTDATA_API_ZONE!;

            const options = {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: '{'
                    + `"zone":"${apiZone}",`
                    + `"url":"${targetUrl}",`
                    + '"format":"json"'
                    + '}'
            };

            const request = await fetch(apiUrl, options)
            const response = await request.json()

            if (response.status_code == 200) {
                return response.body + ""
            } else {
                throw new Error("[BRIGHTDATA] Failed to fetch protected URL: " + JSON.stringify(response))
            }
        } catch (error: any) {
            console.error(`[ScraperService] Error: ${JSON.stringify(error)}`);
            throw error;
        }
    }
}

export const scraperService = new ScraperService();
