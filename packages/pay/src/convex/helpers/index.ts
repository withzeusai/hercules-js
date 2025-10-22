import type {
  AttachParams,
  Autumn,
  CancelParams,
  CheckoutParams,
  QueryParams,
  SetupPaymentParams,
  UsageParams,
} from "autumn-js";
import { wrapSdkCall } from "./utils";
import type {
  AttachArgsType,
  CheckArgsType,
  CheckoutArgsType,
  QueryArgsType,
  CancelArgsType,
  SetupPaymentArgsType,
  TrackArgsType,
  IdentifierOptsType,
  UsageArgsType,
} from "../types";
import { toSnakeCase } from "../utils";

export const track = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: TrackArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.track(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
        excludeChildrenOf: ["properties"],
      }),
    ),
  );
};

export const check = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: CheckArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.check(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
      }),
    ),
  );
};

export const attach = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: AttachArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.attach(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
        excludeChildrenOf: ["checkoutSessionParams"],
      }) as unknown as AttachParams,
    ),
  );
};

export const checkout = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: CheckoutArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.checkout(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
        excludeChildrenOf: ["checkoutSessionParams"],
      }) as unknown as CheckoutParams,
    ),
  );
};

export const usage = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: UsageArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.usage(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
      }) as unknown as UsageParams,
    ),
  );
};

export const autumnQuery = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: QueryArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.query(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
      }) as unknown as QueryParams,
    ),
  );
};

export const cancel = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: CancelArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.cancel(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
      }) as unknown as CancelParams,
    ),
  );
};

export const setupPayment = async ({
  autumn,
  identifierOpts,
  args,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
  args: SetupPaymentArgsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.setupPayment(
      toSnakeCase({
        obj: {
          ...args,
          customer_id: identifierOpts.customerId,
          customer_data: identifierOpts.customerData,
        },
        excludeChildrenOf: ["checkoutSessionParams"],
      }) as unknown as SetupPaymentParams,
    ),
  );
};

export const listProducts = async ({
  autumn,
  identifierOpts,
}: {
  autumn: Autumn;
  identifierOpts: IdentifierOptsType;
}) => {
  return await wrapSdkCall(() =>
    autumn.products.list({
      customer_id: identifierOpts.customerId,
    }),
  );
};

export * as customers from "./customers";
export * as entities from "./entities";
export * as products from "./products";
export * as referrals from "./referrals";
