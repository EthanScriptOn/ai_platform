# TikTok Res MySQL Connection

Created at: 2026-05-19 17:18 CST

## Server

- SSH host: `47.105.124.252`
- SSH port: `218`
- SSH user: `yfduser`
- MySQL listen address on server: `127.0.0.1:3306`
- MySQL data directory: `/app/mysql/data`
- MySQL version: `8.0.45`
- Database: `tiktok_res`

The MySQL port is intentionally bound to server localhost only. Connect from this Mac with an SSH tunnel:

```bash
ssh -p 218 -L 3307:127.0.0.1:3306 yfduser@47.105.124.252
```

Then connect locally:

```bash
mysql -h127.0.0.1 -P3307 -utiktok_res_app -p tiktok_res
```

## Accounts

Application account:

```text
user: tiktok_res_app
password: UOYpTf7XXt8lArxhIuEYutxn5RrgZ3vZ
database: tiktok_res
```

Root account:

```text
user: root
password: MqF7woG10/8Ef2dmw46R6r6ofsoniyzM
host: localhost only
```

## Schema

The schema file is:

```text
/Users/yuebuy/PhpstormProjects/tiktok_res/database/mysql_schema.sql
```

