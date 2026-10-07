export default async function (url, options = {}) {
    const response = await fetch(url, options)

    if (!response.ok) {
        const message = (await response.text()).trim()
        throw new Error(message || `Request failed (${response.status})`)
    }

    return response.json()
}
