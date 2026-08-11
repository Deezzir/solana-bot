import { PublicKey } from '@solana/web3.js';

type DecoderField<T> = {
    name?: string;
    size: number;
    decode?: (data: Buffer, offset: number) => T;
    validate?: (data: Buffer, offset: number) => void;
};

export function skip(size: number): DecoderField<void> {
    return {
        name: undefined,
        size
    };
}

export function discriminator(data: Buffer): DecoderField<void> {
    return {
        name: undefined,
        size: data.byteLength,
        validate: (input, offset) => {
            if (!input.subarray(offset, offset + data.byteLength).equals(data))
                throw new Error(`Header mismatch at offset ${offset}`);
        }
    };
}

export function u8(name?: string): DecoderField<number> {
    return {
        name,
        size: 1,
        decode: (data, offset) => {
            if (data.byteLength < offset + 1) throw new Error(`Buffer too small for u8 at offset ${offset}`);
            return data.readUInt8(offset);
        }
    };
}

export function u16(name?: string): DecoderField<number> {
    return {
        name,
        size: 2,
        decode: (data, offset) => data.readUInt16LE(offset)
    };
}

export function u64(name?: string): DecoderField<bigint> {
    return {
        name,
        size: 8,
        decode: (data, offset) => data.readBigUint64LE(offset)
    };
}

export function bool(name?: string): DecoderField<boolean> {
    return {
        name,
        size: 1,
        decode: (data, offset) => !!data.readUint8(offset)
    };
}

export function pubkey(name?: string): DecoderField<PublicKey> {
    return {
        name,
        size: 32,
        decode: (data, offset) => new PublicKey(data.subarray(offset, offset + 32))
    };
}

abstract class StructDecoder<T> {
    protected abstract layout(): DecoderField<any>[];

    decode(data: Buffer): T {
        const fields = this.layout();
        const result: any = {};
        let offset = 0;

        for (const field of fields) {
            if (data.byteLength < offset + field.size) {
                throw new Error(`Buffer overflow at offset ${offset} for read ${field.size} bytes`);
            }
            if (field.validate) field.validate(data, offset);
            if (field.name && field.decode) result[field.name] = field.decode(data, offset);
            offset += field.size;
        }

        return result as T;
    }
}

export function define_decoder_struct<T extends Record<string, DecoderField<any>>>(fields: T) {
    const layout = Object.entries(fields);
    const decoder = new (class extends StructDecoder<any> {
        protected layout(): DecoderField<any>[] {
            return layout.map(([k, v]) => ({ ...v, name: v.name ?? k }));
        }
    })();

    let current_offset = 0;
    const offsets: Record<string, number> = {};
    for (const [k, v] of layout) {
        const name = v.name ?? k;
        offsets[name] = current_offset;
        current_offset += v.size;
    }
    const total_size = current_offset;

    type Result = {
        [
            K in keyof T as T[K] extends DecoderField<infer R> ? (R extends void ? never : K) : never
        ]: T[K] extends DecoderField<infer R> ? R : never;
    };

    return {
        decode: (data: Buffer): Result => decoder.decode(data) as Result,
        get_offset: (field: keyof T | string): number => offsets[field as string] ?? -1,
        get_size: (): number => total_size
    };
}
