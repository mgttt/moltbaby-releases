import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(dataDir);

const rows = ndtsdb.query(handle, 'ETHUSDT', '1h', 1700000000000, 1703600000000, 10);
console.log('rows[0]:', rows[0]);
console.log('timestamp type:', typeof rows[0]?.timestamp);
console.log('timestamp value:', rows[0]?.timestamp);

ndtsdb.close(handle);
