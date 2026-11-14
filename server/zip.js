// 极简 ZIP 流式写出（store 模式，UTF-8 文件名），无第三方依赖
import fs from 'node:fs';
import zlib from 'node:zlib';

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * files: [{ name: 'a/b.mp3', path: '/abs/path' } | { name, data: Buffer|string }]
 * 写入可写流（http response），返回 Promise
 */
export async function streamZip(out, files) {
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  let streamErr = null;
  out.on?.('error', (e) => (streamErr = e));
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (streamErr || out.destroyed) return reject(streamErr || new Error('连接已关闭'));
      offset += buf.length;
      if (out.write(buf)) resolve();
      else out.once('drain', resolve);
    });

  for (const f of files) {
    let data;
    try {
      data = f.data != null ? Buffer.from(f.data) : fs.readFileSync(f.path);
    } catch {
      continue;
    }
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    await write(local);
    await write(name);
    await write(data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([c, name]));
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}
