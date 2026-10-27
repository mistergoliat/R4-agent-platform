// R4-J4-R5 single-EC2 canary: preload (`node --import`) that binds every TCP listener of the process to
// 127.0.0.1, whatever host the service asks for. Customer Profile listens on all interfaces (`app.listen(port)`)
// and has no host option; this keeps the canary instance off the network without changing CP.
import net from 'node:net';

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const [first] = args;
  if (first !== null && typeof first === 'object') {
    if (first.path === undefined) args[0] = { ...first, host: '127.0.0.1' };
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    args = [first, '127.0.0.1', ...(callback ? [callback] : [])];
  }
  return listen.apply(this, args);
};
