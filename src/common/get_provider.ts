import { PumpProvider, PumpRunner } from '../pump/pump';
import { JupiterProvider } from '../jupiter/jupiter';
import { MeteoraRunner, MeteoraProvider } from '../meteora/meteora';
import { Program } from './common';
import { IProgramProvider } from './trade_common';
import { ISniper } from './snipe_common';
import { BonkRunner, BonkProvider } from '../bonk/bonk';
import { RaydiumRunner, RaydiumProviderInstance } from '../raydium/raydium';
import { SubscriberType } from './subscriber';
import { Executor } from './executor';

type ExecutorOptions = {
    enable_funding?: boolean;
    program?: Program;
};

export function get_program_provider(program: Program = global.PROGRAM): IProgramProvider {
    switch (program) {
        case Program.Pump: {
            return PumpProvider;
        }
        case Program.Meteora: {
            return MeteoraProvider;
        }
        case Program.Jupiter: {
            return JupiterProvider;
        }
        case Program.Bonk: {
            return BonkProvider;
        }
        case Program.Raydium: {
            return RaydiumProviderInstance;
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}

export function create_executor({
    enable_funding = global.FUNDING,
    program = global.PROGRAM
}: ExecutorOptions = {}): Executor {
    const provider = get_program_provider(program);
    return new Executor(provider, enable_funding);
}

export function get_sniper(subscriber_type: SubscriberType, program: Program = global.PROGRAM): ISniper {
    const provider = get_program_provider(program);
    switch (program) {
        case Program.Pump: {
            return new PumpRunner(provider, subscriber_type);
        }
        case Program.Meteora: {
            return new MeteoraRunner(provider, subscriber_type);
        }
        case Program.Bonk: {
            return new BonkRunner(provider, subscriber_type);
        }
        case Program.Jupiter: {
            throw new Error('Jupiter program is not supported for sniping.');
        }
        case Program.Raydium: {
            return new RaydiumRunner(provider, subscriber_type);
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}
