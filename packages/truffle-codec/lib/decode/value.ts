import debugModule from "debug";
const debug = debugModule("codec:decode:value");

import read from "../read";
import * as CodecUtils from "truffle-codec-utils";
import { Types, Values, Errors } from "truffle-codec-utils";
import BN from "bn.js";
import utf8 from "utf8";
import { DataPointer } from "../types/pointer";
import { EvmInfo, DecoderOptions } from "../types/evm";
import { DecoderRequest, GeneratorJunk } from "../types/request";
import { StopDecodingError } from "../types/errors";

export default function* decodeValue(dataType: Types.Type, pointer: DataPointer, info: EvmInfo, options: DecoderOptions = {}): IterableIterator<Values.Result | DecoderRequest | GeneratorJunk> {
  const { state } = info;
  const { permissivePadding, strictAbiMode: strict } = options; //if these are undefined they'll still be falsy so OK

  let bytes: Uint8Array;
  let rawBytes: Uint8Array;
  try {
    bytes = yield* read(pointer, state);
  }
  catch(error) { //error: Errors.DecodingError
    debug("segfault, pointer %o, state: %O", pointer, state);
    if(strict) {
      throw new StopDecodingError(error.error);
    }
    return Errors.makeGenericErrorResult(dataType, error.error);
  }
  rawBytes = bytes;

  debug("type %O", dataType);
  debug("pointer %o", pointer);

  switch(dataType.typeClass) {

    case "bool": {
      if(!checkPaddingLeft(bytes, 1)) {
        let error = new Errors.BoolPaddingError(CodecUtils.Conversion.toHexString(bytes));
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.BoolErrorResult(dataType, error);
      }
      const numeric = CodecUtils.Conversion.toBN(bytes);
      if(numeric.eqn(0)) {
        return new Values.BoolValue(dataType, false);
      }
      else if(numeric.eqn(1)) {
        return new Values.BoolValue(dataType, true);
      }
      else {
        let error = new Errors.BoolOutOfRangeError(numeric);
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.BoolErrorResult(dataType, error);
      }
    }

    case "uint":
      //first, check padding (if needed)
      if(!permissivePadding && !checkPaddingLeft(bytes, dataType.bits/8)) {
        let error = new Errors.UintPaddingError(CodecUtils.Conversion.toHexString(bytes));
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.UintErrorResult(dataType, error);
      }
      //now, truncate to appropriate length (keeping the bytes on the right)
      bytes = bytes.slice(-dataType.bits/8);
      return new Values.UintValue(
        dataType,
        CodecUtils.Conversion.toBN(bytes),
        CodecUtils.Conversion.toBN(rawBytes)
      );
    case "int":
      //first, check padding (if needed)
      if(!permissivePadding && !checkPaddingSigned(bytes, dataType.bits/8)) {
        let error = new Errors.IntPaddingError(CodecUtils.Conversion.toHexString(bytes));
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.IntErrorResult(dataType, error);
      }
      //now, truncate to appropriate length (keeping the bytes on the right)
      bytes = bytes.slice(-dataType.bits/8);
      return new Values.IntValue(
        dataType,
        CodecUtils.Conversion.toSignedBN(bytes),
        CodecUtils.Conversion.toSignedBN(rawBytes)
      );

    case "address":
      if(!permissivePadding && !checkPaddingLeft(bytes, CodecUtils.EVM.ADDRESS_SIZE)) {
        let error = new Errors.AddressPaddingError(CodecUtils.Conversion.toHexString(bytes));
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.AddressErrorResult(dataType, error);
      }
      return new Values.AddressValue(
        dataType,
        CodecUtils.Conversion.toAddress(bytes),
        CodecUtils.Conversion.toHexString(rawBytes)
      );

    case "contract":
      if(!permissivePadding && !checkPaddingLeft(bytes, CodecUtils.EVM.ADDRESS_SIZE)) {
        let error = new Errors.ContractPaddingError(CodecUtils.Conversion.toHexString(bytes));
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.ContractErrorResult(dataType, error);
      }
      const fullType = <Types.ContractType>Types.fullType(dataType, info.userDefinedTypes);
      const contractValueInfo = <Values.ContractValueInfo> (yield* decodeContract(bytes, info));
      return new Values.ContractValue(fullType, contractValueInfo);

    case "bytes":
      switch(dataType.kind) {
        case "static":
          //first, check padding (if needed)
          if(!permissivePadding && !checkPaddingRight(bytes, dataType.length)) {
            let error = new Errors.BytesPaddingError(CodecUtils.Conversion.toHexString(bytes));
            if(strict) {
              throw new StopDecodingError(error);
            }
            return new Errors.BytesStaticErrorResult(dataType, error);
          }
          //now, truncate to appropriate length
          bytes = bytes.slice(0, dataType.length);
          return new Values.BytesStaticValue(
            dataType,
            CodecUtils.Conversion.toHexString(bytes),
            CodecUtils.Conversion.toHexString(rawBytes)
          );
        case "dynamic":
          //no need to check padding here
          return new Values.BytesDynamicValue(dataType, CodecUtils.Conversion.toHexString(bytes));
      }

    case "string":
      //there is no padding check for strings
      return new Values.StringValue(dataType, decodeString(bytes));

    case "function":
      switch(dataType.visibility) {
        case "external":
          if(!checkPaddingRight(bytes, CodecUtils.EVM.ADDRESS_SIZE + CodecUtils.EVM.SELECTOR_SIZE)) {
            let error = new Errors.FunctionExternalNonStackPaddingError(CodecUtils.Conversion.toHexString(bytes));
            if(strict) {
              throw new StopDecodingError(error);
            }
            return new Errors.FunctionExternalErrorResult(dataType, error);
          }
          const address = bytes.slice(0, CodecUtils.EVM.ADDRESS_SIZE);
          const selector = bytes.slice(CodecUtils.EVM.ADDRESS_SIZE, CodecUtils.EVM.ADDRESS_SIZE + CodecUtils.EVM.SELECTOR_SIZE);
          return new Values.FunctionExternalValue(dataType,
            <Values.FunctionExternalValueInfo> (yield* decodeExternalFunction(address, selector, info))
          );
        case "internal":
          if(strict) {
            //internal functions don't go in the ABI!
            //this should never happen, but just to be sure...
            throw new StopDecodingError(
              new Errors.InternalFunctionInABIError()
            );
          }
          if(!checkPaddingLeft(bytes, 2 * CodecUtils.EVM.PC_SIZE)) {
            return new Errors.FunctionInternalErrorResult(
              dataType,
              new Errors.FunctionInternalPaddingError(CodecUtils.Conversion.toHexString(bytes))
            );
          }
          const deployedPc = bytes.slice(-CodecUtils.EVM.PC_SIZE);
          const constructorPc = bytes.slice(-CodecUtils.EVM.PC_SIZE * 2, -CodecUtils.EVM.PC_SIZE);
          return decodeInternalFunction(dataType, deployedPc, constructorPc, info);
      }
      break; //to satisfy TypeScript

    case "enum": {
      const numeric = CodecUtils.Conversion.toBN(bytes);
      const fullType = <Types.EnumType>Types.fullType(dataType, info.userDefinedTypes);
      if(!fullType.options) {
        let error = new Errors.EnumNotFoundDecodingError(fullType, numeric);
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.EnumErrorResult(fullType, error);
      }
      const numOptions = fullType.options.length;
      const numBytes = Math.ceil(Math.log2(numOptions) / 8);
      if(!checkPaddingLeft(bytes, numBytes)) {
        let error = new Errors.EnumPaddingError(fullType, CodecUtils.Conversion.toHexString(bytes));
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.EnumErrorResult(fullType, error);
      }
      if(numeric.ltn(numOptions)) {
        const name = fullType.options[numeric.toNumber()];
        return new Values.EnumValue(fullType, numeric, name);
      }
      else {
        let error = new Errors.EnumOutOfRangeError(fullType, numeric);
        if(strict) {
          throw new StopDecodingError(error);
        }
        return new Errors.EnumErrorResult(fullType, error);
      }
    }

    case "fixed": {
      //skipping padding check as we don't support this anyway
      const hex = CodecUtils.Conversion.toHexString(bytes);
      let error = new Errors.FixedPointNotYetSupportedError(hex);
      if(strict) {
        throw new StopDecodingError(error);
      }
      return new Errors.FixedErrorResult(dataType, error);
    }
    case "ufixed": {
      //skipping padding check as we don't support this anyway
      const hex = CodecUtils.Conversion.toHexString(bytes);
      let error = new Errors.FixedPointNotYetSupportedError(hex);
      if(strict) {
        throw new StopDecodingError(error);
      }
      return new Errors.UfixedErrorResult(dataType, error);
    }
  }
}

export function decodeString(bytes: Uint8Array): Values.StringValueInfo {
  //the following line takes our UTF-8 string... and interprets each byte
  //as a UTF-16 bytepair.  Yikes!  Fortunately, we have a library to repair that.
  let badlyEncodedString = String.fromCharCode.apply(undefined, bytes);
  try {
    //this will throw an error if we have malformed UTF-8
    let correctlyEncodedString = utf8.decode(badlyEncodedString);
    return new Values.StringValueInfoValid(correctlyEncodedString);
  }
  catch(_) {
    //we're going to ignore the precise error and just assume it's because
    //the string was malformed (what else could it be?)
    let hexString = CodecUtils.Conversion.toHexString(bytes);
    return new Values.StringValueInfoMalformed(hexString);
  }
}

//NOTE that this function returns a ContractValueInfo, not a ContractResult
export function* decodeContract(addressBytes: Uint8Array, info: EvmInfo): IterableIterator<Values.ContractValueInfo | DecoderRequest | Uint8Array> {
  let address = CodecUtils.Conversion.toAddress(addressBytes);
  let rawAddress = CodecUtils.Conversion.toHexString(addressBytes);
  let codeBytes: Uint8Array = yield {
    type: "code",
    address
  };
  let code = CodecUtils.Conversion.toHexString(codeBytes);
  let context = CodecUtils.Contexts.findDecoderContext(info.contexts, code);
  if(context !== null && context.contractName !== undefined) {
    return new Values.ContractValueInfoKnown(
      address,
      CodecUtils.Contexts.contextToType(context),
      rawAddress
    );
  }
  else {
    return new Values.ContractValueInfoUnknown(address, rawAddress);
  }
}

//note: address can have extra zeroes on the left like elsewhere, but selector should be exactly 4 bytes
//NOTE this again returns a FunctionExternalValueInfo, not a FunctionExternalResult
export function* decodeExternalFunction(addressBytes: Uint8Array, selectorBytes: Uint8Array, info: EvmInfo): IterableIterator<Values.FunctionExternalValueInfo | DecoderRequest | GeneratorJunk> {
  let contract = <Values.ContractValueInfo> (yield* decodeContract(addressBytes, info));
  let selector = CodecUtils.Conversion.toHexString(selectorBytes);
  if(contract.kind === "unknown") {
    return new Values.FunctionExternalValueInfoUnknown(contract, selector)
  }
  let contractId = (<Types.ContractTypeNative> contract.class).id; //sorry! will be fixed soon!
  let context = Object.values(info.contexts).find(
    context => context.contractId === contractId
  );
  let abiEntry = context.abi !== undefined
    ? context.abi[selector]
    : undefined;
  if(abiEntry === undefined) {
    return new Values.FunctionExternalValueInfoInvalid(contract, selector)
  }
  return new Values.FunctionExternalValueInfoKnown(contract, selector, abiEntry)
}

//this one works a bit differently -- in order to handle errors, it *does* return a FunctionInternalResult
export function decodeInternalFunction(dataType: Types.FunctionInternalType, deployedPcBytes: Uint8Array, constructorPcBytes: Uint8Array, info: EvmInfo): Values.FunctionInternalResult {
  let deployedPc: number = CodecUtils.Conversion.toBN(deployedPcBytes).toNumber();
  let constructorPc: number = CodecUtils.Conversion.toBN(constructorPcBytes).toNumber();
  let context: Types.ContractType = {
    typeClass: "contract",
    kind: "native",
    id: info.currentContext.contractId,
    typeName: info.currentContext.contractName,
    contractKind: info.currentContext.contractKind,
    payable: info.currentContext.payable
  };
  //before anything else: do we even have an internal functions table?
  //if not, we'll just return the info we have without really attemting to decode
  if(!info.internalFunctionsTable) {
    return new Values.FunctionInternalValue(
      dataType,
      new Values.FunctionInternalValueInfoUnknown(context, deployedPc, constructorPc)
    );
  }
  //also before we continue: is the PC zero? if so let's just return that
  if(deployedPc === 0 && constructorPc === 0) {
    return new Values.FunctionInternalValue(
      dataType,
      new Values.FunctionInternalValueInfoException(context, deployedPc, constructorPc)
    );
  }
  //another check: is only the deployed PC zero?
  if(deployedPc === 0 && constructorPc !== 0) {
    return new Errors.FunctionInternalErrorResult(
      dataType,
      new Errors.MalformedInternalFunctionError(context, constructorPc)
    );
  }
  //one last pre-check: is this a deployed-format pointer in a constructor?
  if(info.currentContext.isConstructor && constructorPc === 0) {
    return new Errors.FunctionInternalErrorResult(
      dataType,
      new Errors.DeployedFunctionInConstructorError(context, deployedPc)
    );
  }
  //otherwise, we get our function
  let pc = info.currentContext.isConstructor
    ? constructorPc
    : deployedPc;
  let functionEntry = info.internalFunctionsTable[pc];
  if(!functionEntry) {
    //if it's not zero and there's no entry... error!
    return new Errors.FunctionInternalErrorResult(
      dataType,
      new Errors.NoSuchInternalFunctionError(context, deployedPc, constructorPc)
    );
  }
  if(functionEntry.isDesignatedInvalid) {
    return new Values.FunctionInternalValue(
      dataType,
      new Values.FunctionInternalValueInfoException(context, deployedPc, constructorPc)
    );
  }
  let name = functionEntry.name;
  let mutability = functionEntry.mutability;
  let definedIn: Types.ContractType = {
    typeClass: "contract",
    kind: "native",
    id: functionEntry.contractId,
    typeName: functionEntry.contractName,
    contractKind: functionEntry.contractKind,
    payable: functionEntry.contractPayable
  };
  return new Values.FunctionInternalValue(
    dataType,
    new Values.FunctionInternalValueInfoKnown(context, deployedPc, constructorPc, name, definedIn, mutability)
  );
}

function checkPaddingRight(bytes: Uint8Array, length: number): boolean {
  let padding = bytes.slice(length); //cut off the first length bytes
  return padding.every(paddingByte => paddingByte === 0);
}

//exporting this one for use in stack.ts
export function checkPaddingLeft(bytes: Uint8Array, length: number): boolean {
  let padding = bytes.slice(0, -length); //cut off the last length bytes
  return padding.every(paddingByte => paddingByte === 0);
}

function checkPaddingSigned(bytes: Uint8Array, length: number): boolean {
  let padding = bytes.slice(0, -length); //padding is all but the last length bytes
  let value = bytes.slice(-length); //meanwhile the actual value is those last length bytes
  let signByte = value[0] & 0x80 ? 0xff : 0x00;
  return padding.every(paddingByte => paddingByte === signByte);
}