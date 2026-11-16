// Runs once in mongo-auth's first start (docker-entrypoint-initdb.d), after the root user exists.
const shop = db.getSiblingDB('shop')
shop.orders.insertMany([{ n: 1 }, { n: 2 }])
shop.createUser({ user: 'reader', pwd: 'reader-dev-only', roles: [{ role: 'read', db: 'shop' }] })
db.getSiblingDB('admin').createUser({ user: 'ldapless', pwd: 'sha1-dev-only', roles: [], mechanisms: ['SCRAM-SHA-1'] })
