import axios from 'axios';

export class FlareSolverrService {
    private baseUrl: string;

    constructor() {
        this.baseUrl = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1';
    }

    async fetchProtectedUrl(url: string): Promise<string> {
        try {
            const targetUrl = url;
            const apiKey = process.env.ZENROWS_API_KEY;

            const response = await axios.get('https://api.zenrows.com/v1/', {
                params: {
                    url: targetUrl,
                    apikey: apiKey,
                    js_render: 'false',
                    antibot: 'true',
                    premium_proxy: 'true'
                }
            });

            // fs.writeFileSync('result.html', response.data);


            // console.log(`[FlareSolverr] Requesting ${url}...`);
            // const response = await axios.post(this.baseUrl, {
            //     cmd: 'request.get',
            //     url: url,
            //     maxTimeout: 60000,
            // }, {
            //     headers: {
            //         'Content-Type': 'application/json'
            //     }
            // });

            if (response.data.status === 'ok') {
                console.log(`[FlareSolverr] Success processing ${url}`);
                return response;
            } else {
                throw new Error(`FlareSolverr failed: ${response.data.message}`);
            }
        } catch (error: any) {
            console.error(`[FlareSolverr] Error: ${error.message}`);
            throw error;
        }
    }
}

export const flareSolverrService = new FlareSolverrService();
