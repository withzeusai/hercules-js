import {
  actionGeneric,
  type GenericActionCtx,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import {
  type TrackArgsType,
  type CheckoutArgsType,
  TrackArgs,
  CheckArgs,
  AttachArgs,
  CheckoutArgs,
  type CheckArgsType,
  type AttachArgsType,
  QueryArgs,
  CancelArgs,
  SetupPaymentArgs,
  UsageArgs,
  BillingPortalArgs,
  CreateReferralCodeArgs,
  RedeemReferralCodeArgs,
  CreateEntityArgs,
  GetEntityArgs,
  type GetCustomerArgsType,
  type UpdateCustomerArgsType,
  type CreateCustomerArgsType,
  ExpandArgs,
  type BillingPortalArgsType,
  type GetEntityArgsType,
  type CreateEntityArgsType,
  type CreateReferralCodeArgsType,
  type RedeemReferralCodeArgsType,
  type IdentifierOptsType,
  type CancelArgsType,
  type QueryArgsType,
  type SetupPaymentArgsType,
  type UsageArgsType,
} from "./types";
import * as autumnHelpers from "./helpers";
import { Autumn as AutumnSDK } from "autumn-js";

export class HerculesPay<T extends GenericDataModel> {
  constructor(
    public options: {
      identify: (ctx: GenericActionCtx<T>) => Promise<IdentifierOptsType>;
      secretKey?: string;
      url?: string;
    },
  ) {}

  async getAuthParams({
    ctx,
    requireAuth = true,
  }: {
    ctx: GenericActionCtx<T>;
    requireAuth?: boolean;
  }) {
    const identifierOpts = await this.getIdentifierOpts(ctx);
    const secretKey =
      this.options.secretKey ||
      process.env.HERCULES_PAY_SECRET_KEY ||
      process.env.AUTUMN_SECRET_KEY;

    if (secretKey == null) {
      throw new Error(
        "No secret key found. Please set the HERCULES_PAY_SECRET_KEY environment variable.",
      );
    }

    const autumn = new AutumnSDK({
      secretKey,
    });

    if (requireAuth) {
      if (!identifierOpts) {
        throw new Error("No customer identifier found for Autumn.identify()");
      }
    }

    return {
      autumn,
      identifierOpts,
    };
  }

  async track(ctx: GenericActionCtx<T>, args: TrackArgsType) {
    const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
    return await autumnHelpers.track({
      autumn,
      identifierOpts,
      args,
    });
  }

  async check(ctx: GenericActionCtx<T>, args: CheckArgsType) {
    const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
    return await autumnHelpers.check({
      autumn,
      identifierOpts,
      args,
    });
  }

  async attach(ctx: GenericActionCtx<T>, args: AttachArgsType) {
    const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
    return await autumnHelpers.attach({
      autumn,
      identifierOpts,
      args,
    });
  }

  async checkout(ctx: GenericActionCtx<T>, args: CheckoutArgsType) {
    const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
    return await autumnHelpers.checkout({
      autumn,
      identifierOpts,
      args,
    });
  }

  customers = {
    get: async (ctx: GenericActionCtx<T>, args?: GetCustomerArgsType) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.customers.get({
        autumn,
        identifierOpts,
        args,
      });
    },

    update: async (ctx: GenericActionCtx<T>, args: UpdateCustomerArgsType) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.customers.update({
        autumn,
        identifierOpts,
        args,
      });
    },
    delete: async (ctx: GenericActionCtx<T>) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.customers.discard({
        autumn,
        identifierOpts,
      });
    },
    create: async (ctx: GenericActionCtx<T>, args: CreateCustomerArgsType) => {
      const { autumn } = await this.getAuthParams({
        ctx,
      });
      return await autumnHelpers.customers.create({
        autumn,
        args,
        useArgs: false,
      });
    },

    billingPortal: async (
      ctx: GenericActionCtx<T>,
      args: BillingPortalArgsType,
    ) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.customers.billingPortal({
        autumn,
        identifierOpts,
        args,
      });
    },
  };

  entities = {
    get: async (
      ctx: GenericActionCtx<T>,
      entityId: string,
      args?: Omit<GetEntityArgsType, "entityId">,
    ) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.entities.get({
        autumn,
        identifierOpts,
        args: { entityId, ...(args || {}) },
      });
    },

    create: async (ctx: GenericActionCtx<T>, args: CreateEntityArgsType) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.entities.create({
        autumn,
        identifierOpts,
        args,
      });
    },

    delete: async (ctx: GenericActionCtx<T>, entityId: string) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.entities.discard({
        autumn,
        identifierOpts,
        entityId,
      });
    },
  };

  products = {
    get: async (ctx: GenericActionCtx<T>, productId: string) => {
      const { autumn } = await this.getAuthParams({ ctx, requireAuth: false });
      return await autumnHelpers.products.get({
        autumn,
        productId,
      });
    },
    list: async (ctx: GenericActionCtx<T>) => {
      const { autumn, identifierOpts } = await this.getAuthParams({
        ctx,
        requireAuth: false,
      });

      return await autumnHelpers.products.list({
        autumn,
        identifierOpts,
      });
    },
  };

  referrals = {
    createCode: async (
      ctx: GenericActionCtx<T>,
      args: CreateReferralCodeArgsType,
    ) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.referrals.createCode({
        autumn,
        identifierOpts,
        args,
      });
    },
    redeemCode: async (
      ctx: GenericActionCtx<T>,
      args: RedeemReferralCodeArgsType,
    ) => {
      const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
      return await autumnHelpers.referrals.redeemCode({
        autumn,
        identifierOpts,
        args,
      });
    },
  };

  /**
   * Utility to re-export actions with automatic customer identification.
   * Example usage:
   *   autumn.api().track({ featureId: "message" })
   */
  api() {
    return {
      // Core tracking and checking methods
      track: actionGeneric({
        args: TrackArgs,
        handler: async (ctx: GenericActionCtx<T>, args: TrackArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.track({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      check: actionGeneric({
        args: CheckArgs,
        handler: async (ctx: GenericActionCtx<T>, args: CheckArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.check({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      // Product attachment and checkout
      attach: actionGeneric({
        args: AttachArgs,
        handler: async (ctx: GenericActionCtx<T>, args: AttachArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.attach({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      checkout: actionGeneric({
        args: CheckoutArgs,
        handler: async (ctx: GenericActionCtx<T>, args: CheckoutArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.checkout({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      createCustomer: actionGeneric({
        args: v.object({
          expand: ExpandArgs,
          errorOnNotFound: v.optional(v.boolean()),
        }),
        handler: async (
          ctx: GenericActionCtx<T>,
          args: CreateCustomerArgsType,
        ) => {
          const { autumn, identifierOpts } = await this.getAuthParams({
            ctx,
            requireAuth: args.errorOnNotFound === false ? false : true,
          });

          if (args.errorOnNotFound === false && !identifierOpts) {
            return {
              data: null,
              error: null,
              statusCode: 202,
            };
          }

          return await autumnHelpers.customers.create({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      listProducts: actionGeneric({
        args: {},
        handler: async (ctx: GenericActionCtx<T>) => {
          const { autumn, identifierOpts } = await this.getAuthParams({
            ctx,
            requireAuth: false,
          });

          const result = await autumnHelpers.products.list({
            autumn,
            identifierOpts,
          });

          return result;
        },
      }),

      // Additional general methods
      usage: actionGeneric({
        args: UsageArgs,
        handler: async (ctx: GenericActionCtx<T>, args: UsageArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.usage({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      query: actionGeneric({
        args: QueryArgs,
        handler: async (ctx: GenericActionCtx<T>, args: QueryArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.autumnQuery({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      cancel: actionGeneric({
        args: CancelArgs,
        handler: async (ctx: GenericActionCtx<T>, args: CancelArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.cancel({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      setupPayment: actionGeneric({
        args: SetupPaymentArgs,
        handler: async (
          ctx: GenericActionCtx<T>,
          args: SetupPaymentArgsType,
        ) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.setupPayment({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      billingPortal: actionGeneric({
        args: BillingPortalArgs,
        handler: async (
          ctx: GenericActionCtx<T>,
          args: BillingPortalArgsType,
        ) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });

          return await autumnHelpers.customers.billingPortal({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      createReferralCode: actionGeneric({
        args: CreateReferralCodeArgs,
        handler: async (
          ctx: GenericActionCtx<T>,
          args: CreateReferralCodeArgsType,
        ) => {
          const { autumn, identifierOpts } = await this.getAuthParams({
            ctx,
          });
          return await autumnHelpers.referrals.createCode({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      redeemReferralCode: actionGeneric({
        args: RedeemReferralCodeArgs,
        handler: async (
          ctx: GenericActionCtx<T>,
          args: RedeemReferralCodeArgsType,
        ) => {
          const { autumn, identifierOpts } = await this.getAuthParams({
            ctx,
          });
          return await autumnHelpers.referrals.redeemCode({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      createEntity: actionGeneric({
        args: CreateEntityArgs,
        handler: async (
          ctx: GenericActionCtx<T>,
          args: CreateEntityArgsType,
        ) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
          return await autumnHelpers.entities.create({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),

      getEntity: actionGeneric({
        args: GetEntityArgs,
        handler: async (ctx: GenericActionCtx<T>, args: GetEntityArgsType) => {
          const { autumn, identifierOpts } = await this.getAuthParams({ ctx });
          return await autumnHelpers.entities.get({
            autumn,
            identifierOpts,
            args,
          });
        },
      }),
    };
  }

  async getIdentifierOpts(ctx: GenericActionCtx<T>) {
    const identifierOpts = await this.options.identify(ctx);
    return identifierOpts;
  }
}
