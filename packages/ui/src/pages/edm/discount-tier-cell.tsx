import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SkuImageRow } from "@siteindex/shared";
import { api, apiErrorMessage } from "../../api";
import { Select, useToast } from "../../components";
import type { EdmDiscountTierCapability } from "./discount-tier-capability";

const CLEAR_DISCOUNT_TIER = "__clear_discount_tier__";

export function EdmDiscountTierCell({ projectId, row, tiers, capability }: {
  projectId: string;
  row: SkuImageRow;
  tiers: readonly number[];
  capability: EdmDiscountTierCapability;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async (tier: number | null) => {
      const save = api.edm.setDiscountTier;
      if (!capability.available || !save) throw new Error(capability.message || "折扣档位保存接口尚未就绪。");
      return save(projectId, row.sku, tier);
    },
    onSuccess: async (result) => {
      toast.success(result.discount_tier == null ? `已清除 ${result.sku} 的折扣档位。` : `已保存 ${result.sku} 的折扣档位。`);
      await queryClient.invalidateQueries({ queryKey: ["edm", "images", projectId] });
    },
    onError: (cause) => toast.error(apiErrorMessage(cause, "折扣档位保存失败。")),
  });

  return <Select
    ariaLabel={row.sku + " 折扣档位"}
    className="si-edm-discount-select"
    value={row.discount_tier == null ? "" : String(row.discount_tier)}
    placeholder={row.discount_tier == null ? "未选择" : String(row.discount_tier) + "%"}
    options={[
      ...(row.discount_tier == null ? [] : [{ value: CLEAR_DISCOUNT_TIER, label: "清除选择" }]),
      ...tiers.map((tier) => ({ value: String(tier), label: tier + "%" })),
    ]}
    disabled={!capability.available || tiers.length === 0 || mutation.isPending}
    onValueChange={(value) => {
      if (!capability.available || tiers.length === 0) return;
      mutation.mutate(value === CLEAR_DISCOUNT_TIER ? null : Number(value));
    }}
  />;
}
