// The person id of the old shape, `person:<iface>:<native id>`, as test data: rows of older databases still carry it,
// and the engine stores it as opaque bytes without taking it apart.
export const personId = (iface: unknown, nativeId: unknown): string => `person:${String(iface)}:${String(nativeId)}`;
