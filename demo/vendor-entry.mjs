// Browser bundle entry: the viem pieces the session wallet needs. Built by `npm run build:vendor`.
export { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
export { encodeFunctionData, parseSignature, verifyTypedData, hexToBigInt, numberToHex } from 'viem';
