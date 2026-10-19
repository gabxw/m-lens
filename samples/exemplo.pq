let
    Source = Csv.Document(File.Contents("C:\Dados\vendas.csv"), [Delimiter = ";"]),
    #"Changed Type" = Table.TransformColumnTypes(Source, {{"Valor", type number}}),
    Custom1 = Table.AddColumn(#"Changed Type", "Dobro", each [Valor] * 2),
    StepNaoUsado = Table.Buffer(Custom1),
    Resultado = Table.SelectRows(Custom1, each [Valor] > 0)
in
    Resultado
    