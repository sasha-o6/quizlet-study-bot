import type { Context, Next } from 'hono'
import { createHmac } from 'crypto'

const BOT_TOKEN = process.env.BOT_TOKEN || ''

/**
 * Validates Telegram WebApp initData using HMAC-SHA256.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function parseTelegramInitData(initData: string): Record<string, string> {
    const params = new URLSearchParams(initData)
    const result: Record<string, string> = {}
    for (const [key, value] of params.entries()) {
        result[key] = value
    }
    return result
}

export function validateInitData(initData: string): boolean {
    if (!BOT_TOKEN) return false

    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return false

    params.delete('hash')

    // Sort params alphabetically
    const sortedParams = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')

    // HMAC_SHA256(HMAC_SHA256("WebAppData", bot_token), data_check_string)
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    const computedHash = createHmac('sha256', secretKey).update(sortedParams).digest('hex')

    return computedHash === hash
}

export function getTelegramUserId(initData: string): bigint | null {
    try {
        const params = parseTelegramInitData(initData)
        const userJson = params['user']
        if (!userJson) return null
        const user = JSON.parse(userJson)
        return BigInt(user.id)
    } catch {
        return null
    }
}
