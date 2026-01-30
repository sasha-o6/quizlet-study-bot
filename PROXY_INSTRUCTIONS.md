# How to use your IP (Proxy)

To make the bot use your IP address (or any other IP), you need to provide a **Proxy URL**.

1.  **Open `.env` file** and add:
    ```bash
    PROXY_URL=http://user:password@ip:port
    # or
    PROXY_URL=socks5://ip:port
    ```

2.  **Rebuild the bot**:
    ```bash
    docker-compose up --build -d
    ```

## How to execute from YOUR computer (Tunneling)

If you want the Raspberry Pi to use your **Mac's Internet Connection**:

1.  **Enable Remote Login** on your Mac (System Settings -> General -> Sharing).
2.  **SSH Tunnel from Pi to Mac**:
    On the Raspberry Pi terminal:
    ```bash
    ssh -D 9050 -N -C your-mac-user@your-mac-ip
    ```
    (This creates a SOCKS5 proxy on port 9050 of the Pi).
3.  **Set `.env`**:
    ```bash
    PROXY_URL=socks5://host.docker.internal:9050
    ```
    *Note: `host.docker.internal` might require extra Docker config on Linux. Using the Pi's explicit IP (e.g. `192.168.1.5:9050`) is safer.*

## Best Option: Cookies
Alternatively, simply using the `cookies.json` method I added earlier is usually enough and much easier than setting up a proxy tunnel!
