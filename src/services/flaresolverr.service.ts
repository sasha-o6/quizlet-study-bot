import axios from 'axios';
import cookies from "./cookies.json";

export class FlareSolverrService {
    private baseUrl: string;

    constructor() {
        this.baseUrl = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1';
    }

    async fetchProtectedUrl(url: string): Promise<string> {
        try {
            console.log(`[FlareSolverr] Requesting ${url}...`);
            const response = await axios.post(this.baseUrl, {
                cmd: 'request.get',
                url: url,
                maxTimeout: 180000,
                // cookies: cookies
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (response.data.status === 'ok') {
                console.log(`[FlareSolverr] Success processing ${url}`);
                return response.data.solution.response;
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
