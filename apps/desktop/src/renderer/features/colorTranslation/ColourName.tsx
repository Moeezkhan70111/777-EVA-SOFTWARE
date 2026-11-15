import React from "react";
import { colorToUrdu } from "@erp/domain";
import { useColorDictionary } from "./colorDictionaryStore";

// A colour's name as the stock screens show it: in Urdu from the shared colour list (docs/45), in English when the
// list does not name it. Only the words change: columns, figures and swatches still go by the stored English, and the
// English stays in the tooltip, so nothing is looked up or matched by the Urdu.
//
// One component for every stock matrix that heads its columns with colours (Carton Stock, Upper Stock).

export const ColourName: React.FC<{ colour: string }> = ({ colour }) => {
  const colors = useColorDictionary();
  const urdu = colorToUrdu(colour, colors);
  if (!urdu) return <>{colour}</>;
  return (
    <span className="urdu-text" lang="ur" dir="rtl" title={colour}>
      {urdu}
    </span>
  );
};
